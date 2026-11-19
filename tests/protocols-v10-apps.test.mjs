/**
 * Tests for v1.41 (Team T2) — MCP Apps v10 postMessage bridge:
 * packages/core/src/protocolsV10/mcpAppsV10.ts
 *
 * Covers:
 *  - bridge message validation (jsonrpc 2.0, method must be
 *    known, id type, params object)
 *  - UI capability validation (bridgeVersions must include
 *    1.0)
 *  - resource validation (ui:// URI, mcp-app mime type,
 *    HTML rules from v8, allowedTools array)
 *  - strict CSP (default-deny, no unsafe-inline/eval,
 *    connect-src limited to declared domains + host origin,
 *    frame-ancestors locked to self)
 *  - session handshake (tools/call before ui/initialize
 *    refused; initialize returns host capabilities)
 *  - allowlist arbitration (tool off the allowlist refused,
 *    oversized args refused, rate limit refused)
 *  - origin check (wrong origin refused)
 *  - close / revoke (further messages refused)
 *  - bridge routing (unknown app id -> undefined)
 *  - audit log + snapshot
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v10-apps.test.mjs
 *
 * No network, no DOM, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV10AppBridge,
  McpV10AppSession,
  buildMcpV10AppCsp,
  validateMcpV10AppResource,
  validateMcpV10AppUiCapabilities,
  validateMcpV10BridgeMessage,
} from '../packages/core/dist/index.js';

const RESOURCE = {
  uri: 'ui://demo/panel',
  mimeType: 'text/html;profile=mcp-app',
  html: '<html><body><h1>Demo</h1></body></html>',
  domains: ['cdn.example.com'],
  allowedTools: ['echo'],
};

test('bridge message validation: shape, known methods, id type', () => {
  assert.deepEqual(validateMcpV10BridgeMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }), []);
  assert.deepEqual(validateMcpV10BridgeMessage({ jsonrpc: '2.0', id: 'x', result: { ok: true } }), []);
  assert.ok(validateMcpV10BridgeMessage({ jsonrpc: '1.0', id: 1, method: 'ui/initialize' }).length > 0);
  assert.ok(validateMcpV10BridgeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/explode' }).length > 0);
  assert.ok(validateMcpV10BridgeMessage({ jsonrpc: '2.0', id: {}, method: 'ui/initialize' }).length > 0);
  assert.ok(validateMcpV10BridgeMessage({ jsonrpc: '2.0', id: 1 }).length > 0);
  assert.ok(validateMcpV10BridgeMessage(null).length > 0);
  assert.ok(validateMcpV10BridgeMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', result: {} }).length > 0);
});

test('UI capabilities: bridge version 1.0 required', () => {
  assert.deepEqual(validateMcpV10AppUiCapabilities({ bridgeVersions: ['1.0'] }), []);
  assert.ok(validateMcpV10AppUiCapabilities({ bridgeVersions: ['2.0'] }).some((p) => p.includes('1.0')));
  assert.ok(validateMcpV10AppUiCapabilities({ bridgeVersions: [] }).length > 0);
  assert.ok(validateMcpV10AppUiCapabilities({ bridgeVersions: ['1.0'], loadingState: 'yes' }).length > 0);
  assert.ok(validateMcpV10AppUiCapabilities(null).length > 0);
});

test('resource validation: ui:// + mcp-app mime + v8 HTML rules', () => {
  assert.deepEqual(validateMcpV10AppResource(RESOURCE), []);
  assert.ok(validateMcpV10AppResource({ ...RESOURCE, uri: 'https://example.com/panel' }).some((p) => p.includes('ui://')));
  assert.ok(validateMcpV10AppResource({ ...RESOURCE, mimeType: 'text/html' }).some((p) => p.includes('mcp-app')));
  assert.ok(validateMcpV10AppResource({ ...RESOURCE, html: '' }).length > 0);
  assert.ok(validateMcpV10AppResource({ ...RESOURCE, allowedTools: 'echo' }).length > 0);
  assert.ok(validateMcpV10AppResource(null).length > 0);
});

test('strict CSP: default-deny, no unsafe-inline/eval, domains + host origin only', () => {
  const csp = buildMcpV10AppCsp(RESOURCE, 'app://open-bot');
  assert.match(csp, /default-src 'none'/);
  assert.ok(!csp.includes('unsafe-inline'));
  assert.ok(!csp.includes('unsafe-eval'));
  assert.match(csp, /connect-src 'self' app:\/\/open-bot https:\/\/cdn\.example\.com/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /object-src 'none'/);
  const noDomains = buildMcpV10AppCsp({ ...RESOURCE, domains: [] }, 'app://open-bot');
  assert.ok(!noDomains.includes('https://'));
  assert.match(noDomains, /connect-src 'self' app:\/\/open-bot/);
});

function session(overrides = {}) {
  return new McpV10AppSession({
    appId: 'app-1',
    uri: 'ui://demo/panel',
    toolName: 'demo',
    allowedTools: ['echo'],
    expectedOrigin: 'https://ui.example.com',
    executor: async (tool, args) => ({ tool, args }),
    ...overrides,
  });
}

test('handshake: tools/call before ui/initialize is refused; initialize grants host caps', async () => {
  const s = session();
  const early = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } },
    'https://ui.example.com',
  );
  assert.ok('error' in early);
  assert.match(early.error.message, /ui\/initialize/);
  const init = await s.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'ui/initialize', params: { capabilities: { bridgeVersions: ['1.0'] } } },
    'https://ui.example.com',
  );
  assert.ok('result' in init);
  assert.equal(init.result.capabilities.bridgeVersion, '1.0');
  assert.deepEqual(init.result.capabilities.allowedTools, ['echo']);
  assert.equal(init.result.appId, 'app-1');
  assert.equal(s.isInitialized, true);
  const badInit = await s.handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'ui/initialize', params: { capabilities: { bridgeVersions: ['9.9'] } } },
    'https://ui.example.com',
  );
  assert.ok('error' in badInit);
});

test('allowlist arbitration: off-list tool, oversized args, rate limit', async () => {
  const s = session();
  await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { capabilities: { bridgeVersions: ['1.0'] } } },
    'https://ui.example.com',
  );
  const ok = await s.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { hello: 'world' } } },
    'https://ui.example.com',
  );
  assert.ok('result' in ok);
  assert.deepEqual(ok.result.content, { tool: 'echo', args: { hello: 'world' } });
  assert.equal(s.totalCalls, 1);
  const denied = await s.handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shell_exec', arguments: {} } },
    'https://ui.example.com',
  );
  assert.ok('error' in denied);
  assert.match(denied.error.message, /not allowed/);
  const big = await s.handleMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { blob: 'x'.repeat(70 * 1024) } } },
    'https://ui.example.com',
  );
  assert.ok('error' in big);
  assert.match(big.error.message, /exceed/);
  // Rate limit: 2 calls/minute allowed in this session.
  const limited = session({ maxCallsPerMinute: 2 });
  await limited.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { capabilities: { bridgeVersions: ['1.0'] } } },
    'https://ui.example.com',
  );
  const now = Date.now();
  await limited.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } }, 'https://ui.example.com', now);
  await limited.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {} } }, 'https://ui.example.com', now);
  const third = await limited.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: {} } }, 'https://ui.example.com', now);
  assert.ok('error' in third);
  assert.match(third.error.message, /Rate limit/);
  assert.equal(limited.totalRejected, 1);
});

test('origin check: wrong origin refused; no executor refused', async () => {
  const s = session();
  const wrong = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { capabilities: { bridgeVersions: ['1.0'] } } },
    'https://evil.example.com',
  );
  assert.ok('error' in wrong);
  assert.match(wrong.error.message, /Origin not allowed/);
  assert.equal(s.isInitialized, false);
  const noExec = new McpV10AppSession({ appId: 'app-2', uri: 'ui://demo/panel', toolName: 'demo', allowedTools: ['echo'] });
  await noExec.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { capabilities: { bridgeVersions: ['1.0'] } } },
    '',
  );
  const call = await noExec.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } },
    '',
  );
  assert.ok('error' in call);
  assert.match(call.error.message, /no tool executor/);
});

test('close / revoke: further messages refused; audit log records decisions', async () => {
  const s = session();
  await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { capabilities: { bridgeVersions: ['1.0'] } } },
    'https://ui.example.com',
  );
  await s.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } },
    'https://ui.example.com',
  );
  const closed = await s.handleMessage({ jsonrpc: '2.0', method: 'ui/close' }, 'https://ui.example.com');
  assert.equal(closed, undefined);
  assert.equal(s.isClosed, true);
  const after = await s.handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {} } },
    'https://ui.example.com',
  );
  assert.ok('error' in after);
  assert.match(after.error.message, /closed/);
  const audit = s.auditLog();
  assert.ok(audit.some((e) => e.kind === 'ui/initialize' && e.allowed));
  assert.ok(audit.some((e) => e.kind === 'tools/call' && e.allowed));
  assert.ok(audit.some((e) => e.kind === 'ui/close'));
  const snap = s.snapshot();
  assert.equal(snap.appId, 'app-1');
  assert.equal(snap.callCount, 1);
  assert.equal(snap.closed, true);
  assert.throws(() => new McpV10AppSession({ appId: '', uri: 'ui://x', toolName: 't' }), /non-empty string/);
  assert.throws(() => new McpV10AppSession({ appId: 'a', uri: 'https://x', toolName: 't' }), /ui:\/\//);
});

test('bridge: open / route / unknown app / close', async () => {
  const bridge = new McpV10AppBridge();
  const s = bridge.open({
    appId: 'app-9', uri: 'ui://demo/panel', toolName: 'demo', allowedTools: ['echo'],
    executor: async () => 'pong',
  });
  assert.equal(bridge.get('app-9'), s);
  assert.equal(bridge.list().length, 1);
  const unknown = await bridge.routeMessage('app-nope', { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }, '');
  assert.equal(unknown, undefined);
  await bridge.routeMessage('app-9', { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { capabilities: { bridgeVersions: ['1.0'] } } }, '');
  const call = await bridge.routeMessage('app-9', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } }, '');
  assert.equal(call.result.content, 'pong');
  assert.equal(bridge.close('app-9'), true);
  assert.equal(bridge.close('app-9'), false);
  assert.equal(bridge.get('app-9'), undefined);
});
