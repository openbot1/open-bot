/**
 * Test v1.34 T3: MCP Apps host v14 — registry ui:// + _meta.ui +
 * text fallback + capability negotiation + openAppForClient (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v14-registry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  McpAppsUiRegistryV14,
  MCP_APPS_V14_VERSION,
  UI_V14_TEXT_FALLBACK_MIN_CHARS,
  clampPreferredSizeForClient,
  extractTextFallbackFromResult,
  parseV14ClientCapability,
  negotiateAppsCapability,
  resultHasTextFallback,
  validateTextFallback,
} from '../packages/core/dist/mcp/appsUiV14.js';
import { McpAppHostV14 } from '../packages/core/dist/mcp/appsHostV14.js';

const SAFE_HTML =
  '<!doctype html><html><head><style>body{color:navy}</style></head><body><h1>Hi</h1></body></html>';
const FALLBACK_TEXT =
  'Dashboard: 3 task đang chạy, 2 app đang mở, 128 lần gọi tool hôm nay. Đây là bản text đầy đủ cho client không render được.';
const TOOL_WITH_UI = {
  name: 'show-dashboard',
  description: 'Show a dashboard.',
  inputSchema: { type: 'object', properties: {} },
  _meta: {
    ui: {
      resourceUri: 'ui://my-server/dashboard',
      displayMode: 'inline',
      preferredWidth: 720,
      preferredHeight: 480,
      title: 'Dashboard',
    },
  },
};
const TOOL_RESULT = {
  content: [
    {
      type: 'resource',
      resource: {
        uri: 'ui://my-server/dashboard',
        mimeType: 'text/html;profile=mcp-app',
        text: SAFE_HTML,
      },
    },
    { type: 'text', text: FALLBACK_TEXT },
  ],
};

function setupRegistry() {
  const registry = new McpAppsUiRegistryV14({ now: () => 1_000_000 });
  registry.registerResource({
    uri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'show-dashboard',
    title: 'Dashboard',
    html: SAFE_HTML,
    mimeType: 'text/html;profile=mcp-app',
  });
  return registry;
}

function setupDeclaredRegistry() {
  const registry = setupRegistry();
  registry.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui, { textFallback: FALLBACK_TEXT });
  return registry;
}

test('v14: version + text fallback validation', () => {
  assert.equal(MCP_APPS_V14_VERSION, '14.0.0');
  const fb = validateTextFallback('show-dashboard', FALLBACK_TEXT);
  assert.equal(fb.toolName, 'show-dashboard');
  assert.equal(fb.truncated, false);
  assert.ok(fb.charCount >= UI_V14_TEXT_FALLBACK_MIN_CHARS);
  assert.throws(() => validateTextFallback('t', ''), /thiếu text fallback/);
  assert.throws(() => validateTextFallback('t', 'ngắn'), /quá ngắn/);
  const long = validateTextFallback('t', 'x'.repeat(25_000));
  assert.equal(long.truncated, true);
  assert.ok(long.text.endsWith('(đã cắt bớt)'));
});

test('v14: extract text fallback from tool result', () => {
  assert.equal(extractTextFallbackFromResult(TOOL_RESULT), FALLBACK_TEXT);
  assert.equal(extractTextFallbackFromResult({ content: [{ type: 'resource', text: 'x' }] }), '');
  assert.equal(extractTextFallbackFromResult({}), '');
  assert.equal(resultHasTextFallback(TOOL_RESULT), true);
  assert.equal(resultHasTextFallback({ content: [{ type: 'text', text: 'ngắn' }] }), false);
});

test('v14: parse client capability from handshake', () => {
  const none = parseV14ClientCapability({});
  assert.equal(none.supportsApps, false);
  assert.deepEqual(none.renderModes, []);
  const apps = parseV14ClientCapability({
    capabilities: { apps: { supportsApps: true, renderModes: ['inline', 'pip'], maxWidthPx: 800 } },
  });
  assert.equal(apps.supportsApps, true);
  assert.deepEqual(apps.renderModes, ['inline', 'pip']);
  assert.equal(apps.maxWidthPx, 800);
  // Vị trí experimental cũng được chấp nhận.
  const exp = parseV14ClientCapability({
    capabilities: { experimental: { apps: { render: true, modes: ['fullscreen'] } } },
  });
  assert.equal(exp.supportsApps, true);
  assert.deepEqual(exp.renderModes, ['fullscreen']);
  assert.throws(
    () => parseV14ClientCapability({ capabilities: { apps: { renderModes: ['sideways'] } } }),
    /Render mode không rõ/,
  );
  assert.throws(
    () => parseV14ClientCapability({ capabilities: { apps: { maxWidthPx: -5 } } }),
    /phải là số không âm/,
  );
});

test('v14: negotiate — client hỗ trợ thì gửi UI, không thì text', () => {
  const registry = setupDeclaredRegistry();
  const supporting = parseV14ClientCapability({
    capabilities: { apps: { supportsApps: true, renderModes: ['inline'] } },
  });
  const terminal = parseV14ClientCapability({ capabilities: {} });
  const ok = registry.negotiateForTool('show-dashboard', supporting);
  assert.equal(ok.sendUi, true);
  assert.equal(ok.renderMode, 'inline');
  assert.equal(ok.reasonCode, 'client-supports-apps');
  const textOnly = registry.negotiateForTool('show-dashboard', terminal);
  assert.equal(textOnly.sendUi, false);
  assert.equal(textOnly.reasonCode, 'client-no-apps');
  // Client chỉ hỗ trợ inline nhưng tool xin pip → text.
  registry.registerResource({
    uri: 'ui://my-server/pip-app',
    serverName: 'my-server',
    toolName: 'pip-tool',
    title: 'Pip',
    html: SAFE_HTML,
  });
  registry.declareToolUi('pip-tool', { resourceUri: 'ui://my-server/pip-app', displayMode: 'pip' }, { textFallback: FALLBACK_TEXT });
  const pip = registry.negotiateForTool('pip-tool', supporting);
  assert.equal(pip.sendUi, false);
  assert.equal(pip.reasonCode, 'client-no-render-mode');
  // Tool không khai báo → không gửi UI.
  const noUi = registry.negotiateForTool('unknown-tool', supporting);
  assert.equal(noUi.sendUi, false);
  assert.equal(noUi.reasonCode, 'tool-has-no-ui');
});

test('v14: negotiateAppsCapability thuần — thiếu fallback/resource thì không gửi UI', () => {
  const client = { supportsApps: true, renderModes: ['inline'], maxWidthPx: 0, maxHeightPx: 0 };
  const decl = { resourceUri: 'ui://s/app', server: 's', appName: 'app' };
  assert.equal(
    negotiateAppsCapability(client, { declaration: decl, hasTextFallback: false, resourceRegistered: true }).reasonCode,
    'tool-has-no-fallback',
  );
  assert.equal(
    negotiateAppsCapability(client, { declaration: decl, hasTextFallback: true, resourceRegistered: false }).reasonCode,
    'resource-not-registered',
  );
  const sized = clampPreferredSizeForClient(
    { ...decl, preferredWidth: 1200, preferredHeight: 900 },
    { ...client, maxWidthPx: 800, maxHeightPx: 600 },
  );
  assert.deepEqual(sized, { width: 800, height: 600 });
});

test('v14: declareToolUi từ chối khai báo treo + thiếu fallback', () => {
  const registry = new McpAppsUiRegistryV14({ now: () => 1_000_000 });
  // Chưa đăng ký resource → từ chối.
  assert.throws(
    () => registry.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui, { textFallback: FALLBACK_TEXT }),
    /chưa đăng ký trong registry ui:\/\//,
  );
  // Đăng ký resource rồi nhưng thiếu fallback → từ chối.
  registry.registerResource({
    uri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    title: 'Dashboard',
    html: SAFE_HTML,
  });
  assert.throws(
    () => registry.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui),
    /thiếu text fallback/,
  );
  // Fallback quá ngắn → từ chối.
  assert.throws(
    () => registry.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui, { textFallback: 'ngắn' }),
    /quá ngắn/,
  );
  // Server không khớp → từ chối.
  assert.throws(
    () =>
      registry.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui, {
        textFallback: FALLBACK_TEXT,
        serverName: 'other-server',
      }),
    /không khớp|thuộc server/,
  );
  // Đúng thứ tự → ok, đăng ký lại thì tăng version.
  const first = registry.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui, { textFallback: FALLBACK_TEXT });
  assert.equal(first.version, 1);
  assert.equal(first.serverName, 'my-server');
  const second = registry.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui, { textFallback: FALLBACK_TEXT });
  assert.equal(second.version, 2);
  assert.equal(registry.stats().uiTools, 1);
  // 3 lần từ chối được đếm: resource chưa đăng ký, thiếu fallback,
  // server không khớp. (Fallback quá ngắn ném từ validateTextFallback
  // trước khi tới bước đếm — vẫn là từ chối, chỉ không đếm ở đây.)
  assert.equal(registry.stats().rejectedDeclarations, 3);
});

test('v14: listUiTools + validateToolResult + unregisterServer', () => {
  const registry = setupDeclaredRegistry();
  const tools = registry.listUiTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolName, 'show-dashboard');
  assert.equal(tools[0].resourceRegistered, true);
  assert.equal(tools[0].hasTextFallback, true);
  assert.ok(tools[0].fallbackChars >= UI_V14_TEXT_FALLBACK_MIN_CHARS);
  const checked = registry.validateToolResult('show-dashboard', TOOL_RESULT);
  assert.equal(checked.ok, true);
  assert.equal(checked.textFallback, FALLBACK_TEXT);
  assert.throws(
    () => registry.validateToolResult('show-dashboard', { content: [] }),
    /thiếu text fallback/,
  );
  assert.throws(() => registry.validateToolResult('nope', TOOL_RESULT), /không khai báo UI/);
  const removed = registry.unregisterServer('my-server');
  assert.equal(removed.tools, 1);
  assert.equal(removed.resources, 1);
  assert.equal(registry.size, 0);
});

test('v14: host openAppForClient — client hỗ trợ thì UI, terminal thì text', () => {
  const host = new McpAppHostV14({ now: () => 1_000_000 });
  host.registerResource({
    uri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'show-dashboard',
    title: 'Dashboard',
    html: SAFE_HTML,
    mimeType: 'text/html;profile=mcp-app',
  });
  host.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui, { textFallback: FALLBACK_TEXT });

  const supporting = host.parseClientCapability({
    capabilities: { apps: { supportsApps: true, renderModes: ['inline'] } },
  });
  const ui = host.openAppForClient(TOOL_WITH_UI, TOOL_RESULT, supporting);
  assert.equal(ui.mode, 'ui');
  if (ui.mode !== 'ui') throw new Error('expected ui mode');
  assert.equal(ui.opened.uri, 'ui://my-server/dashboard');
  assert.equal(ui.frameConfigV14.sandbox, 'allow-scripts');
  assert.ok(ui.frameConfigV14.csp.includes("default-src 'none'"));
  assert.ok(ui.bridgeSessionId.startsWith('ui-v14-'));
  assert.equal(host.bridgeSessionForApp(ui.opened.appId), ui.bridgeSessionId);
  assert.equal(host.listOpenApps().length, 1);

  const terminal = host.parseClientCapability({ capabilities: {} });
  const text = host.openAppForClient(TOOL_WITH_UI, TOOL_RESULT, terminal);
  assert.equal(text.mode, 'text');
  if (text.mode !== 'text') throw new Error('expected text mode');
  assert.equal(text.textFallback, FALLBACK_TEXT);
  assert.equal(text.negotiation.reasonCode, 'client-no-apps');

  assert.equal(host.closeApp(ui.opened.appId), true);
  assert.equal(host.listOpenApps().length, 0);
  assert.equal(host.stats().appsOpen, 0);
  assert.equal(host.stats().uiTools, 1);
});

test('v14: host openAppForClient từ chối tool không khai báo UI', () => {
  const host = new McpAppHostV14({ now: () => 1_000_000 });
  const client = host.parseClientCapability({
    capabilities: { apps: { supportsApps: true, renderModes: ['inline'] } },
  });
  assert.throws(
    () => host.openAppForClient({ name: 'plain-tool' }, TOOL_RESULT, client),
    /không khai báo _meta\.ui/,
  );
});

test('v14: host openRegisteredAppForClient + preview + stats', () => {
  const host = new McpAppHostV14({ now: () => 1_000_000 });
  host.registerResource({
    uri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'show-dashboard',
    title: 'Dashboard',
    html: SAFE_HTML,
    mimeType: 'text/html;profile=mcp-app',
  });
  host.declareToolUi('show-dashboard', TOOL_WITH_UI._meta.ui, { textFallback: FALLBACK_TEXT });
  const client = host.parseClientCapability({
    capabilities: { apps: { supportsApps: true, renderModes: ['inline'] } },
  });
  const opened = host.openRegisteredAppForClient('ui://my-server/dashboard', client);
  assert.equal(opened.mode, 'ui');
  const previews = host.listPreviews();
  assert.equal(previews.length, 1);
  assert.equal(previews[0].declaredByTool, 'show-dashboard');
  assert.equal(previews[0].hasTextFallback, true);
  const preview = host.previewApp('ui://my-server/dashboard');
  assert.equal(preview.frameConfig.sandbox, 'allow-scripts');
  assert.deepEqual(preview.audit, []);
  assert.deepEqual(preview.consents, []);
  assert.throws(() => host.previewApp('ui://my-server/missing'), /Không có app nào đăng ký/);
  assert.throws(
    () => host.openRegisteredAppForClient('ui://my-server/missing', client),
    /Không có app nào đăng ký/,
  );
  if (opened.mode === 'ui') host.closeApp(opened.opened.appId);
});
