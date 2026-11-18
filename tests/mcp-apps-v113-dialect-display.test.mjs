/**
 * Test v1.13 T2: MCP Apps host v13 — dialect JSON-RPC ui/ + display modes (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v113-dialect-display.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDefaultHostContext,
  buildUiInitializeResult,
  isUiJsonRpcMessage,
  parseUiJsonRpcMessage,
  UiDialectHost,
  uiJsonRpcError,
  uiJsonRpcNotification,
  uiJsonRpcResult,
  UI_DIALECT_PROTOCOL_VERSION,
  UI_JSONRPC_ERROR_CODES,
} from '../packages/core/dist/mcp/appsUiDialect.js';
import {
  AppDisplayModeManager,
  clampPipGeometry,
  defaultPipGeometry,
  isDisplayMode,
  parseDisplayMode,
  parsePipAnchor,
  pipOverlaps,
  PIP_DEFAULT_HEIGHT,
  PIP_DEFAULT_WIDTH,
} from '../packages/core/dist/mcp/appsDisplayModes.js';

function hostContext(overrides = {}) {
  return buildDefaultHostContext({
    theme: 'dark',
    locale: 'vi',
    timezone: 'Asia/Ho_Chi_Minh',
    platform: 'linux',
    displayMode: 'inline',
    container: { width: 720, height: 480 },
    hostVersion: '0.2.0-test',
    hostName: 'open-bot',
    ...overrides,
  });
}

function initRequest(id = 'init-1', clientInfo = { name: 'sample-app', version: '1.0.0' }) {
  return { jsonrpc: '2.0', id, method: 'ui/initialize', params: { clientInfo } };
}

test('dialect: parse + helpers (result/error/notification, isUiJsonRpcMessage)', () => {
  assert.equal(UI_DIALECT_PROTOCOL_VERSION, 'ui/1.0');
  const req = parseUiJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'ui/message', params: { message: 'hi' } });
  assert.equal(req?.method, 'ui/message');
  assert.equal(parseUiJsonRpcMessage({ jsonrpc: '1.0', method: 'ui/message' }), null);
  assert.equal(parseUiJsonRpcMessage({ jsonrpc: '2.0' }), null);
  assert.equal(parseUiJsonRpcMessage({ jsonrpc: '2.0', method: 'x', id: {} }), null);
  assert.equal(parseUiJsonRpcMessage('nope'), null);
  assert.equal(isUiJsonRpcMessage({ jsonrpc: '2.0', method: 'ui/message' }), true);
  assert.equal(isUiJsonRpcMessage({ type: 'app-ready' }), false);
  assert.deepEqual(uiJsonRpcResult(7, { ok: true }), { jsonrpc: '2.0', id: 7, result: { ok: true } });
  const err = uiJsonRpcError('a', -32601, 'no method');
  assert.equal(err.error?.code, -32601);
  assert.equal(err.error?.message, 'no method');
  const note = uiJsonRpcNotification('ui/message', { message: 'hi' });
  assert.equal(note.jsonrpc, '2.0');
  assert.equal(note.method, 'ui/message');
  assert.equal('id' in note, false);
  const ctx = hostContext();
  const init = buildUiInitializeResult('ui-1', ctx);
  assert.equal(init.protocolVersion, 'ui/1.0');
  assert.equal(init.hostContext.locale, 'vi');
  assert.equal(init.hostContext.timezone, 'Asia/Ho_Chi_Minh');
  assert.equal(init.hostContext.container.width, 720);
});

test('dialect: createSession + ui/initialize returns host context', async () => {
  const host = new UiDialectHost();
  const sessionId = host.createSession({ appUri: 'ui://srv/app', hostContext: hostContext() });
  assert.equal(host.size, 1);
  const res = await host.handleMessage(sessionId, initRequest());
  assert.equal(res?.error, undefined);
  assert.equal(res?.result?.protocolVersion, 'ui/1.0');
  assert.equal(res?.result?.sessionId, sessionId);
  assert.equal(res?.result?.hostContext.theme, 'dark');
  assert.equal(res?.result?.hostContext.locale, 'vi');
  assert.equal(res?.result?.hostContext.displayMode, 'inline');
  assert.deepEqual(res?.result?.capabilities, hostContext().capabilities);
  const snap = host.getSession(sessionId);
  assert.equal(snap?.initialized, true);
  assert.equal(snap?.clientInfo?.name, 'sample-app');
  assert.equal(snap?.messagesIn, 1);
});

test('dialect: methods before initialize are rejected (-32002)', async () => {
  const host = new UiDialectHost();
  const sessionId = host.createSession({ appUri: 'ui://srv/app', hostContext: hostContext() });
  const res = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 'm1',
    method: 'ui/message',
    params: { message: 'too early' },
  });
  assert.equal(res?.error?.code, UI_JSONRPC_ERROR_CODES.notInitialized);
  assert.equal(host.getSession(sessionId)?.initialized, false);
});

test('dialect: unknown method -> -32601, malformed -> -32700, bad params -> -32602', async () => {
  const host = new UiDialectHost();
  const sessionId = host.createSession({ appUri: 'ui://srv/app', hostContext: hostContext() });
  await host.handleMessage(sessionId, initRequest());
  const unknown = await host.handleMessage(sessionId, { jsonrpc: '2.0', id: 'u1', method: 'ui/fly', params: {} });
  assert.equal(unknown?.error?.code, UI_JSONRPC_ERROR_CODES.methodNotFound);
  const malformed = await host.handleMessage(sessionId, { type: 'app-ready' });
  assert.equal(malformed?.error?.code, UI_JSONRPC_ERROR_CODES.parseError);
  const badParams = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 'b1',
    method: 'ui/message',
    params: { message: '' },
  });
  assert.equal(badParams?.error?.code, UI_JSONRPC_ERROR_CODES.invalidParams);
  const arrayParams = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 'b2',
    method: 'ui/message',
    params: ['not-an-object'],
  });
  assert.equal(arrayParams?.error?.code, UI_JSONRPC_ERROR_CODES.invalidParams);
});

test('dialect: ui/update-model-context stores context, validates progress, fires callback', async () => {
  const seen = [];
  const host = new UiDialectHost({ onModelContext: (sid, ctx) => seen.push({ sid, ctx }) });
  const sessionId = host.createSession({ appUri: 'ui://srv/app', hostContext: hostContext() });
  await host.handleMessage(sessionId, initRequest());
  const res = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 'c1',
    method: 'ui/update-model-context',
    params: { context: { taskStatus: 'working', progress: 42, data: { rows: 3 } } },
  });
  assert.equal(res?.error, undefined);
  assert.deepEqual(res?.result?.appliedKeys, ['taskStatus', 'progress', 'data']);
  assert.equal(host.getSession(sessionId)?.modelContext.progress, 42);
  assert.equal(seen.length, 1);
  const badProgress = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 'c2',
    method: 'ui/update-model-context',
    params: { context: { progress: 150 } },
  });
  assert.equal(badProgress?.error?.code, UI_JSONRPC_ERROR_CODES.invalidParams);
});

test('dialect: ui/message + notifications return null, callbacks fire', async () => {
  const messages = [];
  const host = new UiDialectHost({ onMessage: (sid, msg, level) => messages.push({ sid, msg, level }) });
  const sessionId = host.createSession({ appUri: 'ui://srv/app', hostContext: hostContext() });
  await host.handleMessage(sessionId, initRequest());
  const res = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 'm1',
    method: 'ui/message',
    params: { message: 'hello host', level: 'warn' },
  });
  assert.deepEqual(res?.result, { ok: true });
  assert.deepEqual(messages, [{ sid: sessionId, msg: 'hello host', level: 'warn' }]);
  // Notification (no id) -> no response.
  const note = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    method: 'ui/message',
    params: { message: 'fire-and-forget' },
  });
  assert.equal(note, null);
  assert.equal(messages.length, 2);
});

test('dialect: ui/open-link blocked by default, allowed via handler', async () => {
  const opened = [];
  const blocked = new UiDialectHost();
  const sidBlocked = blocked.createSession({ appUri: 'ui://srv/app', hostContext: hostContext() });
  await blocked.handleMessage(sidBlocked, initRequest());
  const denied = await blocked.handleMessage(sidBlocked, {
    jsonrpc: '2.0',
    id: 'l1',
    method: 'ui/open-link',
    params: { url: 'https://example.com' },
  });
  assert.equal(denied?.error?.code, UI_JSONRPC_ERROR_CODES.forbidden);

  const allowed = new UiDialectHost({ onOpenLink: (sid, url) => { opened.push(url); return true; } });
  const sidAllowed = allowed.createSession({
    appUri: 'ui://srv/app',
    hostContext: hostContext(),
    allowOpenLink: true,
  });
  await allowed.handleMessage(sidAllowed, initRequest());
  const ok = await allowed.handleMessage(sidAllowed, {
    jsonrpc: '2.0',
    id: 'l2',
    method: 'ui/open-link',
    params: { url: 'https://example.com/docs' },
  });
  assert.deepEqual(ok?.result, { ok: true, opened: true, url: 'https://example.com/docs' });
  assert.deepEqual(opened, ['https://example.com/docs']);
  const badUrl = await allowed.handleMessage(sidAllowed, {
    jsonrpc: '2.0',
    id: 'l3',
    method: 'ui/open-link',
    params: { url: 'javascript:alert(1)' },
  });
  assert.equal(badUrl?.error?.code, UI_JSONRPC_ERROR_CODES.invalidParams);
});

test('dialect: tools/call goes through the host allowlist + handler, same control path', async () => {
  const calls = [];
  const host = new UiDialectHost({
    onToolsCall: async (sid, name, args) => {
      calls.push({ sid, name, args });
      return `ran ${name}`;
    },
  });
  const sessionId = host.createSession({
    appUri: 'ui://srv/app',
    hostContext: hostContext(),
    allowedTools: ['echo-tool'],
  });
  await host.handleMessage(sessionId, initRequest());
  const ok = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 't1',
    method: 'tools/call',
    params: { name: 'echo-tool', arguments: { text: 'hi' } },
  });
  assert.equal(ok?.error, undefined);
  assert.equal(ok?.result?.content?.[0]?.text, 'ran echo-tool');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { text: 'hi' });
  const denied = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 't2',
    method: 'tools/call',
    params: { name: 'shell-tool', arguments: {} },
  });
  assert.equal(denied?.error?.code, UI_JSONRPC_ERROR_CODES.forbidden);
  assert.equal(calls.length, 1);
  const noName = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 't3',
    method: 'tools/call',
    params: {},
  });
  assert.equal(noName?.error?.code, UI_JSONRPC_ERROR_CODES.invalidParams);
});

test('dialect: ui/close + ui/set-display-mode fire callbacks; batch works', async () => {
  const closed = [];
  const modes = [];
  const host = new UiDialectHost({
    onCloseRequest: (sid) => closed.push(sid),
    onDisplayModeChange: (sid, mode) => modes.push(mode),
  });
  const sessionId = host.createSession({ appUri: 'ui://srv/app', hostContext: hostContext() });
  const batch = await host.handleMessage(sessionId, [
    initRequest('b-init'),
    { jsonrpc: '2.0', id: 'b-mode', method: 'ui/set-display-mode', params: { mode: 'pip' } },
    { jsonrpc: '2.0', id: 'b-close', method: 'ui/close', params: {} },
  ]);
  assert.ok(Array.isArray(batch));
  assert.equal(batch.length, 3);
  assert.equal(batch[1].result?.displayMode, 'pip');
  assert.deepEqual(modes, ['pip']);
  assert.deepEqual(closed, [sessionId]);
  assert.equal(host.getSession(sessionId)?.displayMode, 'pip');
  const badMode = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 'b-bad',
    method: 'ui/set-display-mode',
    params: { mode: 'sideways' },
  });
  assert.equal(badMode?.error?.code, UI_JSONRPC_ERROR_CODES.invalidParams);
  const emptyBatch = await host.handleMessage(sessionId, []);
  assert.equal(emptyBatch?.error?.code, UI_JSONRPC_ERROR_CODES.invalidRequest);
});

test('dialect: host -> app notifications + session limits + close', async () => {
  const host = new UiDialectHost({ maxSessions: 1 });
  const sessionId = host.createSession({ appUri: 'ui://srv/app', hostContext: hostContext() });
  assert.throws(() => host.createSession({ appUri: 'ui://srv/b', hostContext: hostContext() }), /tối đa/);
  await host.handleMessage(sessionId, initRequest());
  const note = host.buildModelContextNotification(sessionId, { taskStatus: 'completed', progress: 100 });
  assert.equal(note?.method, 'ui/model-context-updated');
  assert.equal(note?.params?.context?.progress, 100);
  assert.equal(host.getSession(sessionId)?.modelContext.taskStatus, 'completed');
  const msg = host.buildMessageNotification(sessionId, 'hello app', 'warn');
  assert.equal(msg?.method, 'ui/message');
  const modeNote = host.buildDisplayModeNotification(sessionId, 'fullscreen');
  assert.equal(modeNote?.params?.displayMode, 'fullscreen');
  assert.equal(host.buildModelContextNotification('missing', {}), null);
  assert.equal(host.closeSession(sessionId), true);
  assert.equal(host.closeSession(sessionId), false);
  assert.equal(host.size, 0);
  assert.equal(await host.handleMessage(sessionId, initRequest()), null);
  assert.ok(host.getLog().length > 0);
});

test('dialect: tools/call timeout is enforced', async () => {
  const host = new UiDialectHost({
    onToolsCall: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 'too late';
    },
  });
  const sessionId = host.createSession({
    appUri: 'ui://srv/app',
    hostContext: hostContext(),
    allowedTools: ['slow-tool'],
    toolCallTimeoutMs: 50,
  });
  await host.handleMessage(sessionId, initRequest());
  const res = await host.handleMessage(sessionId, {
    jsonrpc: '2.0',
    id: 'slow-1',
    method: 'tools/call',
    params: { name: 'slow-tool', arguments: {} },
  });
  assert.equal(res?.error?.code, UI_JSONRPC_ERROR_CODES.internalError);
  assert.match(res?.error?.message ?? '', /quá thời gian/);
});

// ---------------------------------------------------------------------------
// Display modes
// ---------------------------------------------------------------------------

test('display: parse + helpers', () => {
  assert.equal(parseDisplayMode('pip'), 'pip');
  assert.equal(isDisplayMode('fullscreen'), true);
  assert.equal(isDisplayMode('sideways'), false);
  assert.throws(() => parseDisplayMode('sideways'), /Display mode/);
  assert.equal(parsePipAnchor('top-left'), 'top-left');
  assert.equal(parsePipAnchor('nowhere'), 'bottom-right');
  const viewport = { width: 1280, height: 800 };
  const geo = defaultPipGeometry('bottom-right', viewport);
  assert.equal(geo.width, PIP_DEFAULT_WIDTH);
  assert.equal(geo.height, PIP_DEFAULT_HEIGHT);
  assert.equal(geo.x, 1280 - 360 - 8);
  assert.equal(geo.y, 800 - 240 - 8);
  assert.equal(pipOverlaps({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }), true);
  assert.equal(pipOverlaps({ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 200, width: 100, height: 100 }), false);
  const clamped = clampPipGeometry({ x: -50, y: 900, width: 5000, height: 10 }, viewport);
  assert.ok(clamped.x >= 8 && clamped.y <= 800 - 160 - 8);
  assert.ok(clamped.width <= 960 && clamped.height >= 160);
});

test('display: register + setMode + one-fullscreen rule', () => {
  const manager = new AppDisplayModeManager({ viewport: { width: 1280, height: 800 } });
  const a = manager.register('app-a');
  assert.equal(a.mode, 'inline');
  assert.equal(a.previousMode, 'inline');
  manager.register('app-b', { mode: 'fullscreen' });
  assert.equal(manager.fullscreenAppId(), 'app-b');
  manager.setMode('app-a', 'fullscreen');
  assert.equal(manager.fullscreenAppId(), 'app-a');
  assert.equal(manager.get('app-b')?.mode, 'inline');
  assert.equal(manager.get('app-b')?.previousMode, 'inline');
  assert.throws(() => manager.setMode('missing', 'pip'), /Không có app/);
  assert.throws(() => manager.setMode('app-a', 'sideways'), /Display mode/);
});

test('display: pip move/resize/anchor clamp to viewport; cascade avoids overlap', () => {
  const manager = new AppDisplayModeManager({ viewport: { width: 800, height: 600 } });
  manager.register('app-a', { mode: 'pip' });
  manager.register('app-b', { mode: 'pip' });
  const a = manager.get('app-a');
  const b = manager.get('app-b');
  assert.ok(a && b);
  assert.equal(pipOverlaps(a.pip, b.pip), false);
  const moved = manager.movePip('app-a', -100, 9999);
  assert.ok(moved.pip.x >= 8 && moved.pip.y <= 600 - 160 - 8);
  const resized = manager.resizePip('app-a', 5000, 5);
  assert.ok(resized.pip.width <= 960 && resized.pip.height >= 160);
  const anchored = manager.anchorPip('app-a', 'top-left');
  assert.equal(anchored.pipAnchor, 'top-left');
  assert.equal(anchored.pip.x, 8);
  assert.equal(anchored.pip.y, 8);
  assert.throws(() => manager.movePip('missing', 0, 0), /Không có app/);
  manager.register('app-c', { mode: 'inline' });
  assert.throws(() => manager.movePip('app-c', 0, 0), /không ở mode pip/);
});

test('display: exitOverlay + cycleMode + pinned + inline height + serialize/restore', () => {
  const manager = new AppDisplayModeManager({ viewport: { width: 1280, height: 800 } });
  manager.register('app-a', { mode: 'inline', inlineHeight: 500 });
  manager.setMode('app-a', 'fullscreen');
  assert.equal(manager.exitOverlay('app-a').mode, 'inline');
  assert.equal(manager.cycleMode('app-a').mode, 'fullscreen');
  assert.equal(manager.cycleMode('app-a').mode, 'pip');
  assert.equal(manager.cycleMode('app-a').mode, 'inline');
  assert.equal(manager.setPinned('app-a', true).pinned, true);
  assert.equal(manager.setInlineHeight('app-a', 5000).inlineHeight, 900);
  assert.equal(manager.setInlineHeight('app-a', 10).inlineHeight, 120);
  const saved = manager.serialize();
  const restored = new AppDisplayModeManager({ viewport: { width: 640, height: 480 } });
  restored.restore(saved);
  assert.equal(restored.get('app-a')?.mode, 'inline');
  assert.equal(restored.get('app-a')?.pinned, true);
  assert.equal(restored.get('app-a')?.inlineHeight, 120);
  assert.deepEqual(manager.pipAppIds(), []);
  manager.setMode('app-a', 'pip');
  assert.deepEqual(manager.pipAppIds(), ['app-a']);
  assert.equal(manager.unregister('app-a'), true);
  assert.equal(manager.unregister('app-a'), false);
  manager.register('app-b');
  manager.setViewport({ width: 400, height: 300 });
  assert.deepEqual(manager.getViewport(), { width: 400, height: 300 });
});
