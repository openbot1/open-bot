/**
 * Test v1.35 T3: MCP Apps bridge v15 (JSON-RPC 2.0 postMessage) +
 * consent v15 (UI-initiated action gate) (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v15-bridge-consent.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UiBridgeHostV15,
  UI_V15_BRIDGE_METHODS,
  UI_V15_ERROR_CODES,
  UI_V15_SRCDOC_ORIGIN,
  isAllowedV15Origin,
  validateV15BridgeMessage,
} from '../packages/core/dist/mcp/appsBridgeV15.js';
import {
  UiConsentManagerV15,
  classifyToolCallV15,
  summarizeArgsForConsentV15,
} from '../packages/core/dist/mcp/appsConsentV15.js';
import { McpAppHostV15 } from '../packages/core/dist/mcp/appsHostV15.js';

const SAFE_HTML =
  '<!doctype html><html><head><style>body{color:navy}</style></head><body><h1>Hi</h1></body></html>';
const FALLBACK_TEXT =
  'Dashboard: 3 task đang chạy, 2 app đang mở, 128 lần gọi tool hôm nay. Đây là bản text đầy đủ cho client không render được.';

function setupHostWithTool() {
  const host = new McpAppHostV15({
    now: () => 1_000_000,
    onToolsCall: async (_sessionId, toolName, args) => ({ ran: toolName, args }),
  });
  host.registry.registerResource({
    uri: 'ui://my-server/dashboard',
    html: SAFE_HTML,
    toolName: 'show-dashboard',
  });
  host.registry.declareToolUi(
    'show-dashboard',
    { resourceUri: 'ui://my-server/dashboard' },
    { textFallback: FALLBACK_TEXT },
  );
  return host;
}

function openDashboard(host) {
  const tool = { name: 'show-dashboard', _meta: { ui: { resourceUri: 'ui://my-server/dashboard' } } };
  const result = {
    content: [{ type: 'text', text: FALLBACK_TEXT }],
  };
  const client = { supportsApps: true, renderModes: ['inline'], maxWidthPx: 0, maxHeightPx: 0 };
  const opened = host.openAppForClient(tool, result, client, {
    allowedTools: ['show-dashboard', 'get-tasks', 'create-task', 'send-email'],
    autoApproveReadOnlyTools: ['get-tasks'],
  });
  assert.equal(opened.mode, 'ui');
  return opened;
}

// ---------------------------------------------------------------------------
// Bridge: validate + origin + initialize
// ---------------------------------------------------------------------------

test('v15 bridge: method list đúng SEP-1865 mở rộng (tools/list, resources/list, post-message)', () => {
  for (const method of [
    'ui/initialize',
    'ui/update-model-context',
    'ui/message',
    'ui/open-link',
    'ui/post-message',
    'ui/close',
    'ui/set-display-mode',
    'ui/ready',
    'ui/telemetry',
    'tools/call',
    'tools/list',
    'resources/read',
    'resources/list',
  ]) {
    assert.ok(UI_V15_BRIDGE_METHODS.includes(method), method);
  }
  assert.equal(UI_V15_ERROR_CODES.consentRequired, -32010);
  assert.equal(UI_V15_ERROR_CODES.consentDenied, -32011);
  assert.equal(UI_V15_ERROR_CODES.sessionClosed, -32013);
  assert.equal(UI_V15_ERROR_CODES.rateLimited, -32014);
});

test('v15 bridge: validate message — sai JSON-RPC / method lạ / thiếu params', () => {
  assert.equal(validateV15BridgeMessage({}).ok, false);
  assert.equal(validateV15BridgeMessage({ jsonrpc: '2.0', method: 'ui/initialize', id: 1 }).ok, true);
  const badMethod = validateV15BridgeMessage({ jsonrpc: '2.0', method: 'eval', id: 1 });
  assert.equal(badMethod.ok, false);
  assert.equal(badMethod.errorCode, -32601);
  const badCall = validateV15BridgeMessage({ jsonrpc: '2.0', method: 'tools/call', params: {}, id: 2 });
  assert.equal(badCall.ok, false);
  assert.equal(badCall.errorCode, -32602);
  const badRead = validateV15BridgeMessage({ jsonrpc: '2.0', method: 'resources/read', params: {}, id: 3 });
  assert.equal(badRead.ok, false);
  const badLink = validateV15BridgeMessage({ jsonrpc: '2.0', method: 'ui/open-link', params: {}, id: 4 });
  assert.equal(badLink.ok, false);
  const badPost = validateV15BridgeMessage({ jsonrpc: '2.0', method: 'ui/post-message', params: {}, id: 5 });
  assert.equal(badPost.ok, false);
  assert.equal(isAllowedV15Origin('null', UI_V15_SRCDOC_ORIGIN), true);
  assert.equal(isAllowedV15Origin('https://evil.example', UI_V15_SRCDOC_ORIGIN), false);
});

test('v15 bridge: chưa initialize thì method khác bị từ chối -32002; origin sai bị chặn', async () => {
  const bridge = new UiBridgeHostV15({ now: () => 1_000_000 });
  const session = bridge.createSession('ui://my-server/dashboard', 'my-server', {
    allowedTools: ['get-tasks'],
  });
  const beforeInit = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    'null',
  );
  assert.equal(beforeInit?.error?.code, -32002);
  const wrongOrigin = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'ui/initialize', params: {}, id: 2 },
    'https://evil.example',
  );
  assert.equal(wrongOrigin, null);
  assert.equal(session.blockedMessages, 1);
  const init = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'ui/initialize', params: { clientInfo: { name: 'dashboard', version: '1.0.0' } }, id: 3 },
    'null',
  );
  assert.equal(init?.error, undefined);
  assert.equal(init?.result?.protocolVersion, 'ui/1.0');
  assert.equal(init?.result?.hostContext?.consentRequired, true);
  assert.equal(init?.result?.hostContext?.visualiserAvailable, true);
  assert.equal(session.initialized, true);
});

test('v15 bridge: tools/list + resources/list + ui/message + ui/ready + display-mode', async () => {
  const bridge = new UiBridgeHostV15({ now: () => 1_000_000 });
  const session = bridge.createSession('ui://my-server/dashboard', 'my-server', {
    allowedTools: ['get-tasks', 'create-task'],
    allowedResources: ['ui://my-server/dashboard', 'ui://my-server/data'],
  });
  await bridge.handleMessage(session.sessionId, { jsonrpc: '2.0', method: 'ui/initialize', params: {}, id: 1 }, 'null');
  const list = await bridge.handleMessage(session.sessionId, { jsonrpc: '2.0', method: 'tools/list', id: 2 }, 'null');
  assert.deepEqual(list?.result?.tools, [{ name: 'get-tasks' }, { name: 'create-task' }]);
  const resources = await bridge.handleMessage(session.sessionId, { jsonrpc: '2.0', method: 'resources/list', id: 3 }, 'null');
  assert.equal(resources?.result?.total, 2);
  const ready = await bridge.handleMessage(session.sessionId, { jsonrpc: '2.0', method: 'ui/ready', id: 4 }, 'null');
  assert.equal(ready?.result?.ok, true);
  const mode = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'ui/set-display-mode', params: { mode: 'fullscreen' }, id: 5 },
    'null',
  );
  assert.equal(mode?.result?.displayMode, 'fullscreen');
  assert.equal(session.displayMode, 'fullscreen');
  const badMode = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'ui/set-display-mode', params: { mode: 'sideways' }, id: 6 },
    'null',
  );
  assert.equal(badMode?.error?.code, -32602);
  // Notification (không id) → null, không crash.
  const notif = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'ui/message', params: { text: 'hello', level: 'info' } },
    'null',
  );
  assert.equal(notif, null);
});

test('v15 bridge: tools/call ngoài allowlist → -32003; open-link chặn mặc định; post-message chặn mặc định', async () => {
  const bridge = new UiBridgeHostV15({ now: () => 1_000_000 });
  const session = bridge.createSession('ui://my-server/dashboard', 'my-server', {
    allowedTools: ['get-tasks'],
  });
  await bridge.handleMessage(session.sessionId, { jsonrpc: '2.0', method: 'ui/initialize', params: {}, id: 1 }, 'null');
  const denied = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'delete-all', arguments: {} }, id: 2 },
    'null',
  );
  assert.equal(denied?.error?.code, -32003);
  const link = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'https://example.com' }, id: 3 },
    'null',
  );
  assert.equal(link?.error?.code, -32003);
  const post = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'ui/post-message', params: { text: 'spam' }, id: 4 },
    'null',
  );
  assert.equal(post?.error?.code, -32003);
  const badScheme = await bridge.handleMessage(
    session.sessionId,
    { jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'javascript:alert(1)' }, id: 5 },
    'null',
  );
  assert.equal(badScheme?.error?.code, -32003);
});

test('v15 bridge: session không tồn tại → sessionClosed; quá nhiều session → lỗi', async () => {
  const bridge = new UiBridgeHostV15({ now: () => 1_000_000 });
  const gone = await bridge.handleMessage('nope', { jsonrpc: '2.0', method: 'ui/initialize', params: {}, id: 1 }, 'null');
  assert.equal(gone?.error?.code, -32013);
  const small = new UiBridgeHostV15({ now: () => 1_000_000 });
  for (let i = 0; i < 32; i += 1) {
    small.createSession(`ui://s/app${i}`, 's');
  }
  assert.throws(() => small.createSession('ui://s/app32', 's'), /tối đa 32 session/);
});

test('v15 bridge: notification builders host → app đúng method', () => {
  const bridge = new UiBridgeHostV15({ now: () => 1_000_000 });
  const session = bridge.createSession('ui://my-server/dashboard', 'my-server');
  const ctx = bridge.notifyModelContextUpdated(session.sessionId, { taskStatus: 'completed' });
  assert.equal(ctx.method, 'ui/model-context-updated');
  assert.equal(ctx.jsonrpc, '2.0');
  assert.equal('id' in ctx, false);
  const tool = bridge.notifyToolResult(session.sessionId, 'get-tasks', { count: 3 });
  assert.equal(tool.method, 'ui/tool-result');
  const consent = bridge.notifyConsentDecided(session.sessionId, 'consent-v15-1', 'approved', 'create-task');
  assert.equal(consent.method, 'ui/consent-decided');
  assert.equal(consent.params?.decision, 'approved');
});

// ---------------------------------------------------------------------------
// Consent: classification + manager
// ---------------------------------------------------------------------------

test('v15 consent: phân loại tool — read-only / side-effect / sensitive / không rõ', () => {
  assert.equal(classifyToolCallV15('get-tasks').kind, 'read-only');
  assert.equal(classifyToolCallV15('list-files').kind, 'read-only');
  assert.equal(classifyToolCallV15('search-web').kind, 'read-only');
  assert.equal(classifyToolCallV15('create-task').kind, 'side-effect');
  assert.equal(classifyToolCallV15('send-email').kind, 'side-effect');
  assert.equal(classifyToolCallV15('delete-file').kind, 'side-effect');
  assert.equal(classifyToolCallV15('charge-card').kind, 'sensitive');
  assert.equal(classifyToolCallV15('get-secret', { key: 'api_token' }).kind, 'sensitive');
  assert.equal(classifyToolCallV15('admin-purge').kind, 'sensitive');
  // Tool lạ → mặc định side-effect (fail-closed).
  assert.equal(classifyToolCallV15('do-something-unknown').kind, 'side-effect');
});

test('v15 consent: tóm tắt args che secret + cắt chuỗi dài', () => {
  const summary = summarizeArgsForConsentV15({
    title: 'Hello',
    apiKey: 'sk-live-123456',
    password: 'hunter2',
    notes: 'x'.repeat(600),
  });
  assert.ok(summary.includes('*** (đã che)'));
  assert.ok(!summary.includes('sk-live-123456'));
  assert.ok(!summary.includes('hunter2'));
  assert.ok(summary.includes('đã cắt'));
  assert.ok(summary.includes('Hello'));
});

test('v15 consent: request → pending; read-only allowlist auto-approve; denied tool ném ngay', () => {
  const manager = new UiConsentManagerV15({ now: () => 1_000_000 });
  manager.setPolicy({
    appUri: 'ui://my-server/dashboard',
    autoApproveReadOnlyTools: ['get-tasks'],
    deniedTools: ['delete-all'],
    alwaysRequireConsentTools: ['get-secrets'],
    allowOneShot: true,
  });
  // Tool bị cấm → ném, không tạo request.
  assert.throws(
    () =>
      manager.requestConsent({
        sessionId: 's1',
        appUri: 'ui://my-server/dashboard',
        serverName: 'my-server',
        toolName: 'delete-all',
      }),
    /bị cấm/,
  );
  // Side-effect → pending.
  const pending = manager.requestConsent({
    sessionId: 's1',
    appUri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'create-task',
    args: { title: 'Mua sữa' },
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.kind, 'side-effect');
  assert.ok(pending.argsSummary.includes('Mua sữa'));
  assert.equal(manager.pendingCount, 1);
  // Read-only trong allowlist → auto-approved ngay.
  const auto = manager.requestConsent({
    sessionId: 's1',
    appUri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'get-tasks',
  });
  assert.equal(auto.status, 'approved');
  assert.equal(auto.decidedBy, 'auto');
  // Sensitive → luôn pending, không auto dù có trong allowlist.
  const sensitive = manager.requestConsent({
    sessionId: 's1',
    appUri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'charge-card',
    args: { amount: 100 },
  });
  assert.equal(sensitive.status, 'pending');
  assert.equal(sensitive.kind, 'sensitive');
  // Read-only bị ép consent → pending.
  const forced = manager.requestConsent({
    sessionId: 's1',
    appUri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'get-secrets',
  });
  assert.equal(forced.status, 'pending');
});

test('v15 consent: decide approve/deny, quyết lại thì lỗi, hết hạn thì expired', () => {
  let nowMs = 1_000_000;
  const manager = new UiConsentManagerV15({ now: () => nowMs });
  const req = manager.requestConsent({
    sessionId: 's1',
    appUri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'create-task',
    args: { title: 'A' },
  });
  const approved = manager.decide(req.id, 'approved');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decidedBy, 'user');
  assert.throws(() => manager.decide(req.id, 'denied'), /đã approved/);
  const req2 = manager.requestConsent({
    sessionId: 's1',
    appUri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'send-email',
    args: { to: 'a@example.com' },
  });
  const denied = manager.decide(req2.id, 'denied');
  assert.equal(denied.status, 'denied');
  // Hết hạn: nhảy thời gian qua TTL rồi sweep.
  const req3 = manager.requestConsent({
    sessionId: 's1',
    appUri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'create-task',
    args: {},
    ttlMs: 1000,
  });
  nowMs += 2000;
  assert.equal(manager.expireSweep(), 1);
  assert.equal(manager.get(req3.id)?.status, 'expired');
  assert.throws(() => manager.decide(req3.id, 'approved'), /đã expired/);
  assert.throws(() => manager.decide('nope', 'approved'), /không tồn tại/);
  const stats = manager.stats();
  assert.equal(stats.approved, 1);
  assert.equal(stats.denied, 1);
  assert.equal(stats.expired, 1);
});

test('v15 consent: audit hash chain nguyên vẹn + isUsable/consume one-shot', () => {
  const manager = new UiConsentManagerV15({ now: () => 1_000_000 });
  const req = manager.requestConsent({
    sessionId: 's1',
    appUri: 'ui://my-server/dashboard',
    serverName: 'my-server',
    toolName: 'charge-card',
    args: { amount: 5 },
  });
  assert.equal(manager.isUsable(req.id), false);
  manager.decide(req.id, 'approved');
  assert.equal(manager.isUsable(req.id), true);
  assert.equal(manager.consume(req.id), true);
  assert.equal(manager.isUsable(req.id), false);
  assert.equal(manager.get(req.id), undefined);
  assert.equal(manager.verifyAuditChain().ok, true);
  assert.ok(manager.auditLog().length >= 2);
  assert.ok(manager.auditLog().some((e) => e.action === 'requested'));
  assert.ok(manager.auditLog().some((e) => e.action === 'approved'));
});

// ---------------------------------------------------------------------------
// Host: luồng consent end-to-end qua bridge
// ---------------------------------------------------------------------------

test('v15 host: tools/call side-effect → consentRequired, duyệt → chạy đúng args, từ chối → lỗi', async () => {
  const host = setupHostWithTool();
  const opened = openDashboard(host);
  assert.equal(opened.mode, 'ui');
  const sessionId = opened.mode === 'ui' ? opened.bridgeSessionId : '';
  await host.handleBridgeMessage(
    sessionId,
    { jsonrpc: '2.0', method: 'ui/initialize', params: {}, id: 1 },
    'null',
  );
  // Read-only trong allowlist → chạy ngay, không consent.
  const read = await host.handleBridgeMessage(
    sessionId,
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'get-tasks', arguments: { status: 'open' } }, id: 2 },
    'null',
  );
  assert.equal(read?.error, undefined);
  assert.equal(read?.result?.result?.ran, 'get-tasks');
  assert.deepEqual(read?.result?.result?.args, { status: 'open' });
  // Side-effect → consentRequired + pending consent xuất hiện.
  const call = await host.handleBridgeMessage(
    sessionId,
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'create-task', arguments: { title: 'Mua sữa' } }, id: 3 },
    'null',
  );
  assert.equal(call?.error?.code, -32010);
  const pending = host.listPendingConsents();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.toolName, 'create-task');
  assert.ok(pending[0]?.argsSummary.includes('Mua sữa'));
  // Duyệt → tool chạy với đúng args gốc, consent bị consume (one-shot).
  const response = await host.decideConsent(pending[0].id, 'approved');
  assert.equal(response?.error, undefined);
  assert.equal(response?.id, 3);
  assert.equal(response?.result?.result?.ran, 'create-task');
  assert.deepEqual(response?.result?.result?.args, { title: 'Mua sữa' });
  assert.equal(host.consent.isUsable(pending[0].id), false);
  // Gọi lại side-effect khác rồi từ chối → lỗi consentDenied.
  const call2 = await host.handleBridgeMessage(
    sessionId,
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'send-email', arguments: { to: 'a@b.c' } }, id: 4 },
    'null',
  );
  assert.equal(call2?.error?.code, -32010);
  const pending2 = host.listPendingConsents();
  assert.equal(pending2.length, 1);
  const denied = await host.decideConsent(pending2[0].id, 'denied');
  assert.equal(denied?.error?.code, -32011);
  assert.equal(denied?.id, 4);
});

test('v15 host: host không có handler tools/call → app không gọi được tool nào', async () => {
  const host = new McpAppHostV15({ now: () => 1_000_000 });
  host.registry.registerResource({ uri: 'ui://my-server/dashboard', html: SAFE_HTML });
  host.registry.declareToolUi(
    'show-dashboard',
    { resourceUri: 'ui://my-server/dashboard' },
    { textFallback: FALLBACK_TEXT },
  );
  const tool = { name: 'show-dashboard', _meta: { ui: { resourceUri: 'ui://my-server/dashboard' } } };
  const client = { supportsApps: true, renderModes: ['inline'], maxWidthPx: 0, maxHeightPx: 0 };
  const opened = host.openAppForClient(
    tool,
    { content: [{ type: 'text', text: FALLBACK_TEXT }] },
    client,
    { allowedTools: ['get-tasks'], autoApproveReadOnlyTools: ['get-tasks'] },
  );
  assert.equal(opened.mode, 'ui');
  const sessionId = opened.mode === 'ui' ? opened.bridgeSessionId : '';
  await host.handleBridgeMessage(sessionId, { jsonrpc: '2.0', method: 'ui/initialize', params: {}, id: 1 }, 'null');
  const read = await host.handleBridgeMessage(
    sessionId,
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'get-tasks', arguments: {} }, id: 2 },
    'null',
  );
  // Auto-approve xong nhưng không có handler → lỗi nội bộ, không chạy âm thầm.
  assert.equal(read?.error?.code, -32603);
});
