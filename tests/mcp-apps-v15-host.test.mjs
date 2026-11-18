/**
 * Test v1.35 T3: MCP Apps host v15 — registry (MIME profile, manifest,
 * host context) + host open/negotiate (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v15-host.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  McpAppsUiRegistryV15,
  MCP_APPS_V15_VERSION,
  buildHostContextV15,
  validateAppHtmlV15,
  validateAppManifestV15,
  validateAppMimeTypeV15,
  parseV14ClientCapability,
} from '../packages/core/dist/mcp/appsUiV15.js';
import { McpAppHostV15 } from '../packages/core/dist/mcp/appsHostV15.js';

const SAFE_HTML =
  '<!doctype html><html><head><style>body{color:navy}</style></head><body><h1>Hi</h1></body></html>';
const FALLBACK_TEXT =
  'Dashboard: 3 task đang chạy, 2 app đang mở, 128 lần gọi tool hôm nay. Đây là bản text đầy đủ cho client không render được.';
const TOOL_RESULT = {
  content: [{ type: 'text', text: FALLBACK_TEXT }],
};

function setupRegistry() {
  const registry = new McpAppsUiRegistryV15({ now: () => 1_000_000 });
  registry.registerResource({
    uri: 'ui://my-server/dashboard',
    html: SAFE_HTML,
    title: 'Dashboard',
    toolName: 'show-dashboard',
    mimeType: 'text/html;profile=mcp-app',
  });
  registry.registerManifest({
    name: 'dashboard',
    version: '1.2.0',
    server: 'my-server',
    resourceUri: 'ui://my-server/dashboard',
    capabilities: ['tools-call'],
    sandboxProfile: 'interactive',
    cspProfile: 'strict',
    toolName: 'show-dashboard',
  });
  registry.declareToolUi(
    'show-dashboard',
    { resourceUri: 'ui://my-server/dashboard', displayMode: 'inline' },
    { textFallback: FALLBACK_TEXT, serverName: 'my-server' },
  );
  return registry;
}

function clientSupportsApps() {
  return parseV14ClientCapability({
    capabilities: { apps: { supportsApps: true, renderModes: ['inline', 'fullscreen'] } },
  });
}

function clientTextOnly() {
  return parseV14ClientCapability({ capabilities: {} });
}

test('v15 registry: version + MIME profile bắt buộc', () => {
  assert.equal(MCP_APPS_V15_VERSION, '15.0.0');
  const ok = validateAppMimeTypeV15('text/html;profile=mcp-app');
  assert.equal(ok.profile, 'mcp-app');
  assert.throws(() => validateAppMimeTypeV15('text/html'), /phải là "text\/html;profile=mcp-app"/);
  assert.throws(() => validateAppMimeTypeV15('text/html;profile=other'), /phải là/);
  assert.throws(() => validateAppMimeTypeV15(undefined), /phải là/);
});

test('v15 registry: MIME trần bị từ chối ngay lúc đăng ký resource', () => {
  const registry = new McpAppsUiRegistryV15({ now: () => 1_000_000 });
  assert.throws(
    () =>
      registry.registerResource({
        uri: 'ui://my-server/plain',
        html: SAFE_HTML,
        mimeType: 'text/html',
      }),
    /phải là "text\/html;profile=mcp-app"/,
  );
  assert.equal(registry.hasResource('ui://my-server/plain'), false);
  // Không truyền mimeType → mặc định đúng profile, đăng ký được.
  const entry = registry.registerResource({ uri: 'ui://my-server/plain', html: SAFE_HTML });
  assert.equal(entry.mimeType, 'text/html;profile=mcp-app');
});

test('v15 registry: HTML cấm <base href> / <form action> ra ngoài', () => {
  const registry = new McpAppsUiRegistryV15({ now: () => 1_000_000 });
  assert.throws(
    () =>
      registry.registerResource({
        uri: 'ui://my-server/bad-base',
        html: '<!doctype html><html><head><base href="https://evil.example/"></head><body>x</body></html>',
      }),
    /base href/,
  );
  assert.throws(
    () =>
      registry.registerResource({
        uri: 'ui://my-server/bad-form',
        html: '<!doctype html><html><body><form action="https://evil.example/submit"></form></body></html>',
      }),
    /form action/,
  );
  assert.throws(
    () => validateAppHtmlV15('ui://my-server/x', '<p>đoạn HTML lẻ</p>'),
    /HTML document đầy đủ/,
  );
  const withScript = validateAppHtmlV15(
    'ui://my-server/x',
    '<!doctype html><html><head><script src="https://cdn.example/lib.js"></script></head><body>x</body></html>',
  );
  assert.equal(withScript.ok, true);
  assert.ok(withScript.warnings.length >= 1);
});

test('v15 manifest: validate đủ cửa (tên, semver, server, capability, profile chéo)', () => {
  const base = {
    name: 'dashboard',
    version: '1.2.0',
    server: 'my-server',
    resourceUri: 'ui://my-server/dashboard',
  };
  const { manifest, warnings } = validateAppManifestV15({ ...base, capabilities: ['tools-call'] });
  assert.equal(manifest.name, 'dashboard');
  assert.equal(manifest.sandboxProfile, 'display-only');
  assert.equal(manifest.cspProfile, 'strict');
  assert.deepEqual(warnings, []);

  assert.throws(() => validateAppManifestV15({ ...base, name: 'Bad Name' }), /kebab-case/);
  assert.throws(() => validateAppManifestV15({ ...base, version: '1.2' }), /semver/);
  assert.throws(() => validateAppManifestV15({ ...base, server: 'other-server' }), /thuộc server/);
  assert.throws(
    () => validateAppManifestV15({ ...base, name: 'other-app' }),
    /không khớp đoạn cuối/,
  );
  assert.throws(
    () => validateAppManifestV15({ ...base, capabilities: ['fly-to-moon'] }),
    /Capability không rõ/,
  );
  assert.throws(
    () => validateAppManifestV15({ ...base, capabilities: ['media-microphone'] }),
    /CSP profile "media"/,
  );
  assert.throws(
    () => validateAppManifestV15({ ...base, capabilities: ['open-link'] }),
    /interactive/,
  );
  assert.throws(
    () => validateAppManifestV15({ ...base, sandboxProfile: 'privileged' }),
    /privileged.*tools-call|tools-call/,
  );
  const media = validateAppManifestV15({
    ...base,
    capabilities: ['media-microphone'],
    cspProfile: 'media',
    sandboxProfile: 'interactive',
  });
  assert.ok(media.warnings.some((w) => /quyền media/.test(w)));
  const network = validateAppManifestV15({ ...base, cspProfile: 'network' });
  assert.ok(network.warnings.some((w) => /network/.test(w)));
});

test('v15 manifest: treo (resource chưa đăng ký) bị từ chối + đếm rejected', () => {
  const registry = new McpAppsUiRegistryV15({ now: () => 1_000_000 });
  assert.throws(
    () =>
      registry.registerManifest({
        name: 'ghost',
        version: '1.0.0',
        server: 'my-server',
        resourceUri: 'ui://my-server/ghost',
      }),
    /chưa đăng ký/,
  );
  assert.equal(registry.stats().rejectedManifests, 1);
  assert.equal(registry.hasManifest('ui://my-server/ghost'), false);
});

test('v15 registry: luồng register → manifest → declare → list + stats', () => {
  const registry = setupRegistry();
  assert.equal(registry.hasResource('ui://my-server/dashboard'), true);
  assert.equal(registry.hasManifest('ui://my-server/dashboard'), true);
  assert.equal(registry.hasToolUi('show-dashboard'), true);
  const snapshot = registry.listUiTools()[0];
  assert.equal(snapshot.toolName, 'show-dashboard');
  assert.equal(snapshot.hasManifest, true);
  assert.equal(snapshot.manifestVersion, '1.2.0');
  assert.equal(snapshot.sandboxProfile, 'interactive');
  assert.deepEqual(snapshot.capabilities, ['tools-call']);
  const stats = registry.stats();
  assert.equal(stats.uiTools, 1);
  assert.equal(stats.uiToolsWithManifest, 1);
  assert.equal(stats.uiToolsWithFallback, 1);
  assert.equal(stats.v14LegacyApps, 0);
  // App v14 cũ (không manifest) vẫn liệt kê được, đếm legacy.
  registry.registerResource({ uri: 'ui://my-server/legacy', html: SAFE_HTML });
  registry.declareToolUi(
    'show-legacy',
    { resourceUri: 'ui://my-server/legacy' },
    { textFallback: FALLBACK_TEXT },
  );
  assert.equal(registry.listUiTools().find((t) => t.toolName === 'show-legacy')?.hasManifest, false);
  assert.equal(registry.stats().v14LegacyApps, 1);
  // Gỡ server xoá cả manifest.
  const removed = registry.unregisterServer('my-server');
  assert.equal(removed.tools, 2);
  assert.equal(removed.manifests, 1);
  assert.equal(registry.size, 0);
});

test('v15 host context: build đủ trường, không rò rỉ, validate locale/size', () => {
  const ctx = buildHostContextV15({
    sessionId: 'v15-1',
    theme: 'dark',
    locale: 'vi',
    timezone: 'Asia/Ho_Chi_Minh',
    platform: 'linux',
    displayMode: 'fullscreen',
    containerWidthPx: 800,
    containerHeightPx: 600,
  });
  assert.equal(ctx.protocolVersion, 'ui/1.0');
  assert.equal(ctx.hostVersion, '15.0.0');
  assert.equal(ctx.locale, 'vi');
  assert.equal(ctx.timezone, 'Asia/Ho_Chi_Minh');
  assert.equal(ctx.consentRequired, true);
  assert.equal(ctx.visualiserAvailable, true);
  assert.ok(ctx.capabilities.includes('tools-call'));
  assert.ok(ctx.capabilities.includes('consent'));
  assert.ok(!('token' in ctx) && !('path' in ctx));
  assert.throws(() => buildHostContextV15({ sessionId: 'x', locale: 'not a locale!!' }), /Locale không hợp lệ/);
  assert.throws(() => buildHostContextV15({ sessionId: 'x', containerWidthPx: -5 }), /không âm/);
  assert.throws(() => buildHostContextV15({ sessionId: '' }), /sessionId rỗng/);
});

test('v15 host: open UI cho client hỗ trợ + text cho client text-only', () => {
  const host = new McpAppHostV15({ now: () => 1_000_000 });
  host.registry.registerResource({
    uri: 'ui://my-server/dashboard',
    html: SAFE_HTML,
    toolName: 'show-dashboard',
  });
  host.registry.registerManifest({
    name: 'dashboard',
    version: '1.2.0',
    server: 'my-server',
    resourceUri: 'ui://my-server/dashboard',
    capabilities: [],
  });
  host.registry.declareToolUi(
    'show-dashboard',
    { resourceUri: 'ui://my-server/dashboard' },
    { textFallback: FALLBACK_TEXT },
  );
  const tool = { name: 'show-dashboard', _meta: { ui: { resourceUri: 'ui://my-server/dashboard' } } };
  const opened = host.openAppForClient(tool, TOOL_RESULT, clientSupportsApps(), {
    locale: 'vi',
    timezone: 'Asia/Ho_Chi_Minh',
  });
  assert.equal(opened.mode, 'ui');
  if (opened.mode === 'ui') {
    assert.equal(opened.appUri, 'ui://my-server/dashboard');
    assert.ok(opened.bridgeSessionId.startsWith('v15-'));
    assert.equal(opened.hostContext.locale, 'vi');
    assert.equal(opened.negotiation.sendUi, true);
    assert.equal(host.openAppCount, 1);
    assert.equal(host.listOpenApps()[0]?.toolName, 'show-dashboard');
    assert.equal(host.closeAppBySession(opened.bridgeSessionId), true);
    assert.equal(host.openAppCount, 0);
    assert.equal(host.closeAppBySession(opened.bridgeSessionId), false);
  }
  const text = host.openAppForClient(tool, TOOL_RESULT, clientTextOnly());
  assert.equal(text.mode, 'text');
  if (text.mode === 'text') {
    assert.ok(text.textFallback.includes('Dashboard'));
    assert.equal(text.negotiation.sendUi, false);
  }
});

test('v15 host: tool chưa khai báo UI / thiếu fallback thì không mở được', () => {
  const host = new McpAppHostV15({ now: () => 1_000_000 });
  const tool = { name: 'no-ui-tool' };
  assert.throws(
    () => host.openAppForClient(tool, TOOL_RESULT, clientSupportsApps()),
    /không khai báo _meta\.ui/,
  );
  host.registry.registerResource({ uri: 'ui://my-server/dash2', html: SAFE_HTML });
  assert.throws(
    () =>
      host.openAppForClient(
        { name: 'dash2', _meta: { ui: { resourceUri: 'ui://my-server/dash2' } } },
        TOOL_RESULT,
        clientSupportsApps(),
      ),
    /chưa đăng ký UI/,
  );
  // Kết quả thiếu text fallback → validateToolResult chặn ở cửa UI.
  host.registry.declareToolUi(
    'dash2',
    { resourceUri: 'ui://my-server/dash2' },
    { textFallback: FALLBACK_TEXT },
  );
  const emptyResult = { content: [{ type: 'text', text: 'ngắn' }] };
  assert.throws(
    () =>
      host.openAppForClient(
        { name: 'dash2', _meta: { ui: { resourceUri: 'ui://my-server/dash2' } } },
        emptyResult,
        clientSupportsApps(),
      ),
    /thiếu text fallback/,
  );
});

test('v15 host: open đính kèm visualisation khi kết quả có dữ liệu chart', () => {
  const host = new McpAppHostV15({ now: () => 1_000_000 });
  host.registry.registerResource({ uri: 'ui://my-server/chart', html: SAFE_HTML });
  host.registry.declareToolUi(
    'show-chart',
    { resourceUri: 'ui://my-server/chart' },
    { textFallback: FALLBACK_TEXT },
  );
  const chartResult = {
    content: [
      { type: 'text', text: FALLBACK_TEXT },
      {
        type: 'text',
        text: JSON.stringify([
          { label: 'A', value: 10 },
          { label: 'B', value: 20 },
          { label: 'C', value: 30 },
        ]),
      },
    ],
  };
  const tool = { name: 'show-chart', _meta: { ui: { resourceUri: 'ui://my-server/chart' } } };
  const opened = host.openAppForClient(tool, chartResult, clientSupportsApps());
  assert.equal(opened.mode, 'ui');
  if (opened.mode === 'ui') {
    assert.ok(opened.visualisation);
    assert.equal(opened.visualisation?.kind, 'bar-chart');
  }
  // Tắt autoVisualise → không đính kèm.
  const plain = host.openAppForClient(tool, chartResult, clientTextOnly(), { autoVisualise: false });
  assert.equal(plain.mode, 'text');
  if (plain.mode === 'text') assert.equal(plain.visualisation, undefined);
});

test('v15 host: stats tổng hợp registry + bridge + consent + visualiser', () => {
  const host = new McpAppHostV15({ now: () => 1_000_000 });
  const stats = host.stats();
  assert.equal(stats.registry.uiTools, 0);
  assert.equal(stats.bridgeSessions, 0);
  assert.equal(stats.openApps, 0);
  assert.equal(stats.skills, 0);
  assert.equal(stats.consent.pending, 0);
  assert.equal(stats.visualiser.total, 0);
});
