/**
 * Test v1.34 T3: MCP Apps host v14 — bridge postMessage `ui/*` +
 * consent + audit + sandbox CSP + preview (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v14-bridge.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UiBridgeHostV14,
  UI_V14_BRIDGE_METHODS,
  UI_V14_ERROR_CODES,
  UI_V14_SRCDOC_ORIGIN,
  isAllowedV14Origin,
  validateV14BridgeMessage,
} from '../packages/core/dist/mcp/appsBridgeV14.js';
import {
  McpAppsPreviewPanelV14,
  UI_V14_IFRAME_SANDBOX,
  buildStrictCspV14,
  buildV14FrameConfig,
  detectSandboxEscapeAttempts,
  isValidAllowListHost,
  validateHtmlDocumentV14,
  validateSandboxAllowList,
} from '../packages/core/dist/mcp/appsPreviewV14.js';
import { McpAppsUiRegistryV14 } from '../packages/core/dist/mcp/appsUiV14.js';

const SAFE_HTML =
  '<!doctype html><html><head><style>body{color:navy}</style></head><body><h1>Hi</h1></body></html>';
const FALLBACK_TEXT =
  'Dashboard: 3 task đang chạy, 2 app đang mở, 128 lần gọi tool hôm nay. Đây là bản text đầy đủ cho client không render được.';

function setupBridge() {
  const registry = new McpAppsUiRegistryV14({ now: () => 1_000_000 });
  registry.registerResource({
    uri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'show-dashboard',
    title: 'Dashboard',
    html: SAFE_HTML,
    mimeType: 'text/html;profile=mcp-app',
  });
  registry.declareToolUi(
    'show-dashboard',
    { resourceUri: 'ui://my-server/dashboard', displayMode: 'inline' },
    { textFallback: FALLBACK_TEXT },
  );
  const calls = [];
  const bridge = new UiBridgeHostV14({
    now: () => 1_000_000,
    registry,
    onToolsCall: async (_sessionId, toolName, args) => {
      calls.push({ toolName, args });
      return { echo: toolName, args };
    },
  });
  const sessionId = bridge.createSession({
    appUri: 'ui://my-server/dashboard',
    expectedOrigin: 'null',
    allowedTools: ['show-dashboard'],
  });
  return { registry, bridge, sessionId, calls };
}

async function initialize(bridge, sessionId) {
  const res = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'ui/initialize',
    id: 1,
    params: {},
  });
  assert.equal(res.error, undefined);
  assert.equal(res.result.protocolVersion, 'ui/1.0');
  return res;
}

test('v14: bridge method allow-list + origin validation', () => {
  assert.ok(UI_V14_BRIDGE_METHODS.includes('ui/initialize'));
  assert.ok(UI_V14_BRIDGE_METHODS.includes('tools/call'));
  assert.ok(UI_V14_BRIDGE_METHODS.includes('resources/read'));
  assert.ok(!UI_V14_BRIDGE_METHODS.includes('ui/hack'));
  assert.equal(UI_V14_SRCDOC_ORIGIN, 'null');
  assert.equal(isAllowedV14Origin('null', 'null'), true);
  assert.equal(isAllowedV14Origin('https://evil.example', 'null'), false);
  assert.equal(isAllowedV14Origin('*', '*'), false);
  assert.equal(isAllowedV14Origin('https://app.example.com', 'https://app.example.com'), true);
  assert.equal(isAllowedV14Origin(undefined, 'null'), false);

  const ok = validateV14BridgeMessage({ jsonrpc: '2.0', method: 'tools/call', id: 7, params: { name: 'x' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.message.method, 'tools/call');
  assert.equal(ok.message.id, 7);
  // Notification không có id vẫn hợp lệ.
  const notif = validateV14BridgeMessage({ jsonrpc: '2.0', method: 'ui/ready', params: {} });
  assert.equal(notif.ok, true);
  assert.equal(notif.message.id, undefined);
  // Sai định dạng → lỗi rõ ràng, không throw.
  assert.equal(validateV14BridgeMessage(null).ok, false);
  assert.equal(validateV14BridgeMessage({ jsonrpc: '1.0', method: 'ui/ready' }).errorCode, -32600);
  assert.equal(validateV14BridgeMessage({ jsonrpc: '2.0', method: 'ui/hack' }).errorCode, -32601);
  assert.equal(validateV14BridgeMessage({ jsonrpc: '2.0' }).errorCode, -32600);
  assert.equal(
    validateV14BridgeMessage({ jsonrpc: '2.0', method: 'tools/call', params: 'not-object' }).errorCode,
    -32602,
  );
  assert.equal(
    validateV14BridgeMessage({ jsonrpc: '2.0', method: 'tools/call', id: { bad: true } }).errorCode,
    -32600,
  );
});

test('v14: bridge sai origin bị drop im lặng + ghi audit', async () => {
  const { bridge, sessionId } = setupBridge();
  const res = await bridge.handlePostMessage(sessionId, 'https://evil.example', {
    jsonrpc: '2.0',
    method: 'ui/initialize',
    id: 1,
    params: {},
  });
  assert.equal(res, null);
  const dropped = bridge.listActions({ outcome: 'dropped' });
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].detail, /Origin không được phép/);
  // Session không tồn tại cũng trả null.
  const unknown = await bridge.handlePostMessage('no-such-session', 'null', {
    jsonrpc: '2.0',
    method: 'ui/initialize',
    id: 1,
    params: {},
  });
  assert.equal(unknown, null);
});

test('v14: bridge tools/call trước initialize bị từ chối', async () => {
  const { bridge, sessionId } = setupBridge();
  const res = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 1,
    params: { name: 'show-dashboard', arguments: {} },
  });
  assert.equal(res.error.code, UI_V14_ERROR_CODES.notInitialized);
  assert.equal(bridge.getSession(sessionId).initialized, false);
});

test('v14: bridge initialize + update-model-context + message + ready', async () => {
  const { bridge, sessionId } = setupBridge();
  await initialize(bridge, sessionId);
  const snap = bridge.getSession(sessionId);
  assert.equal(snap.initialized, true);
  assert.equal(snap.appUri, 'ui://my-server/dashboard');

  const updated = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'ui/update-model-context',
    id: 2,
    params: { modelContext: { taskStatus: 'working', progress: 42 } },
  });
  assert.equal(updated.error, undefined);
  assert.equal(updated.result.ok, true);
  assert.equal(bridge.getSession(sessionId).modelContext.progress, 42);

  // ui/message là notification → trả null nhưng vẫn ghi audit.
  const msgRes = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'ui/message',
    params: { level: 'warn', message: 'cảnh báo thử' },
  });
  assert.equal(msgRes, null);
  assert.ok(bridge.listActions({}).some((a) => a.method === 'ui/message'));

  const ready = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'ui/ready',
    params: {},
  });
  assert.equal(ready, null);
  assert.equal(bridge.getSession(sessionId).ready, true);

  // Notification host → view.
  const notif = bridge.buildModelContextNotification(sessionId, { progress: 55 });
  assert.equal(notif.method, 'ui/model-context-updated');
  assert.equal(notif.params.modelContext.progress, 55);
  const hostNotif = bridge.buildHostContextNotification(sessionId, { theme: 'dark' });
  assert.equal(hostNotif.method, 'ui/host-context-updated');
});

test('v14: bridge tools/call qua consent — chưa duyệt thì chặn, duyệt rồi thì chạy', async () => {
  const { bridge, sessionId, calls } = setupBridge();
  await initialize(bridge, sessionId);

  // Lần 1: chưa có consent → lỗi consent-required kèm consentId.
  const first = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 10,
    params: { name: 'show-dashboard', arguments: { q: 1 } },
  });
  assert.equal(first.error.code, UI_V14_ERROR_CODES.consentRequired);
  assert.ok(first.error.data.consentId);
  assert.equal(calls.length, 0);
  const pending = bridge.listPendingConsents(sessionId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action, 'tools/call:show-dashboard');
  assert.equal(pending[0].status, 'pending');
  // Consent-required cũng ghi audit.
  assert.ok(bridge.listActions({ outcome: 'consent-required' }).length >= 1);

  // User từ chối 1 consent khác (tạo từ tool khác bị chặn trước đó
  // thì không có) — duyệt consent đang chờ rồi gọi lại.
  assert.equal(bridge.decideConsent(pending[0].consentId, true), true);
  assert.equal(bridge.decideConsent(pending[0].consentId, true), false); // đã quyết rồi
  assert.equal(bridge.decideConsent('no-such-consent', true), false);
  const second = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 11,
    params: { name: 'show-dashboard', arguments: { q: 1 } },
  });
  assert.equal(second.error, undefined);
  assert.equal(second.result.ok, true);
  assert.equal(second.result.result.echo, 'show-dashboard');
  assert.equal(calls.length, 1);
  assert.ok(bridge.listActions({ outcome: 'ok' }).some((a) => a.method === 'tools/call'));
  // Audit log hash-chain có entry.
  assert.ok(bridge.auditEntries().length > 0);
});

test('v14: bridge từ chối tool ngoài allow-list + link ngoài + resource lạ', async () => {
  const { bridge, sessionId } = setupBridge();
  await initialize(bridge, sessionId);

  const forbidden = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 20,
    params: { name: 'run-shell', arguments: {} },
  });
  assert.equal(forbidden.error.code, UI_V14_ERROR_CODES.forbidden);

  const link = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'ui/open-link',
    id: 21,
    params: { url: 'https://example.com' },
  });
  assert.equal(link.error.code, UI_V14_ERROR_CODES.forbidden);
  const badLink = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'ui/open-link',
    id: 22,
    params: { url: 'javascript:alert(1)' },
  });
  assert.equal(badLink.error.code, -32602);

  const external = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'resources/read',
    id: 23,
    params: { uri: 'https://example.com/data.json' },
  });
  assert.equal(external.error.code, UI_V14_ERROR_CODES.forbidden);

  // Resource ui:// đã đăng ký + trong allow-list → ok (metadata, không trả HTML).
  const read = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'resources/read',
    id: 24,
    params: { uri: 'ui://my-server/dashboard' },
  });
  assert.equal(read.error, undefined);
  assert.equal(read.result.uri, 'ui://my-server/dashboard');
  assert.equal(read.result.mimeType, 'text/html;profile=mcp-app');

  // Resource ui:// khác không trong allow-list → chặn.
  const other = await bridge.handlePostMessage(sessionId, 'null', {
    jsonrpc: '2.0',
    method: 'resources/read',
    id: 25,
    params: { uri: 'ui://other-server/app' },
  });
  assert.equal(other.error.code, UI_V14_ERROR_CODES.forbidden);
});

test('v14: bridge batch + close session', async () => {
  const { bridge, sessionId } = setupBridge();
  const batch = await bridge.handlePostMessage(sessionId, 'null', [
    { jsonrpc: '2.0', method: 'ui/initialize', id: 1, params: {} },
    { jsonrpc: '2.0', method: 'ui/ready', params: {} },
    { jsonrpc: '2.0', method: 'ui/hack', id: 2, params: {} },
  ]);
  assert.ok(Array.isArray(batch));
  assert.equal(batch.length, 2); // ready là notification → không response
  assert.equal(batch[0].result.protocolVersion, 'ui/1.0');
  assert.equal(batch[1].error.code, -32601);
  const emptyBatch = await bridge.handlePostMessage(sessionId, 'null', []);
  assert.equal(emptyBatch.error.code, -32600);

  assert.equal(bridge.closeSession(sessionId), true);
  assert.equal(bridge.closeSession(sessionId), false);
  assert.equal(bridge.getSession(sessionId), undefined);
  assert.equal(bridge.size, 0);
});

test('v14: CSP nghiêm mặc định cấm hết, allow-list mở từng host', () => {
  const strict = buildStrictCspV14({});
  assert.ok(strict.includes("default-src 'none'"));
  assert.ok(strict.includes("connect-src 'none'"));
  assert.ok(strict.includes("frame-src 'none'"));
  assert.ok(strict.includes("form-action 'none'"));
  assert.ok(strict.includes("base-uri 'none'"));
  assert.ok(strict.includes("worker-src 'none'"));
  assert.ok(strict.includes("img-src data:"));
  const opened = buildStrictCspV14({
    scriptHosts: ['cdn.example.com'],
    imageHosts: ['img.example.com'],
    connectHosts: ['api.example.com'],
  });
  assert.ok(opened.includes('https://cdn.example.com'));
  assert.ok(opened.includes('https://img.example.com'));
  assert.ok(opened.includes('https://api.example.com'));
  assert.ok(!opened.includes("connect-src 'none'"));

  assert.equal(isValidAllowListHost('cdn.example.com'), true);
  assert.equal(isValidAllowListHost('*.example.com'), true);
  assert.equal(isValidAllowListHost('*'), false);
  assert.equal(isValidAllowListHost('evil.com/path'), false);
  assert.equal(isValidAllowListHost('evil.com:8080'), false);
  assert.equal(isValidAllowListHost(''), false);
  assert.throws(() => validateSandboxAllowList({ scriptHosts: ['*'] }), /không hợp lệ/);
  const cleaned = validateSandboxAllowList({ scriptHosts: ['B.Example.COM', 'b.example.com'] });
  assert.deepEqual(cleaned.scriptHosts, ['b.example.com']);
});

test('v14: quét thoát sandbox + validate HTML document', () => {
  assert.deepEqual(detectSandboxEscapeAttempts(SAFE_HTML), []);
  const parent = detectSandboxEscapeAttempts(
    '<!doctype html><html><body><script>window.parent.document.title</script></body></html>',
  );
  assert.ok(parent.some((f) => f.code === 'escape-parent-access' && f.severity === 'blocking'));
  const star = detectSandboxEscapeAttempts(
    "<!doctype html><html><body><script>window.parent.postMessage(data, '*')</script></body></html>",
  );
  assert.ok(star.some((f) => f.code === 'escape-postmessage-star'));
  const frame = detectSandboxEscapeAttempts(
    '<!doctype html><html><body><iframe src="https://evil.example"></iframe></body></html>',
  );
  assert.ok(frame.some((f) => f.code === 'escape-external-frame'));
  const storage = detectSandboxEscapeAttempts(
    '<!doctype html><html><body><script>localStorage.getItem("k")</script></body></html>',
  );
  assert.ok(storage.some((f) => f.code === 'escape-storage'));

  const good = validateHtmlDocumentV14(SAFE_HTML);
  assert.equal(good.valid, true);
  assert.equal(good.isFullDocument, true);
  const fragment = validateHtmlDocumentV14('<p>chỉ là đoạn lẻ</p>');
  assert.equal(fragment.valid, false);
  assert.equal(fragment.isFullDocument, false);
  assert.equal(fragment.findings[0].code, 'not-full-document');
  const evil = validateHtmlDocumentV14(
    '<!doctype html><html><body><script>window.top.location="https://evil.example"</script></body></html>',
  );
  assert.equal(evil.valid, false);
  assert.match(evil.blockedReason, /parent\/top/);
});

test('v14: frame config sandbox + preview panel', () => {
  const frame = buildV14FrameConfig({ uri: 'ui://my-server/dashboard', title: 'Dashboard', html: SAFE_HTML });
  assert.equal(frame.sandbox, UI_V14_IFRAME_SANDBOX);
  assert.equal(frame.sandbox, 'allow-scripts');
  assert.ok(!frame.sandbox.includes('allow-same-origin'));
  assert.ok(frame.srcdoc.includes('Content-Security-Policy'));
  assert.ok(frame.srcdoc.includes('<title>Dashboard</title>'));
  assert.equal(frame.expectedOrigin, 'null');
  assert.throws(
    () => buildV14FrameConfig({ uri: 'ui://x/y', title: 'X', html: '<p>lẻ</p>' }),
    /HTML document đầy đủ/,
  );

  const registry = new McpAppsUiRegistryV14({ now: () => 1_000_000 });
  registry.registerResource({
    uri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'show-dashboard',
    title: 'Dashboard',
    html: SAFE_HTML,
    mimeType: 'text/html;profile=mcp-app',
  });
  registry.declareToolUi(
    'show-dashboard',
    { resourceUri: 'ui://my-server/dashboard', displayMode: 'inline' },
    { textFallback: FALLBACK_TEXT },
  );
  const panel = new McpAppsPreviewPanelV14({ registry });
  const list = panel.listPreviews();
  assert.equal(list.length, 1);
  assert.equal(list[0].declaredByTool, 'show-dashboard');
  assert.equal(list[0].hasTextFallback, true);
  const preview = panel.previewApp('ui://my-server/dashboard');
  assert.equal(preview.frameConfig.sandbox, 'allow-scripts');
  assert.equal(preview.auditActionCount, 0);
  assert.equal(panel.stats().appsRegistered, 1);
  assert.equal(panel.stats().uiTools, 1);
  assert.equal(panel.stats().version, '14.0.0');
  assert.throws(() => panel.previewApp('ui://my-server/missing'), /Không có app nào đăng ký/);
});
