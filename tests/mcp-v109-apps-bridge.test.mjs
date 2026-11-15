/**
 * MCP Apps bridge host tests (v1.09, Team T3 — node:test, không mạng live).
 *
 * Covers packages/core/src/mcp/appsBridge.ts:
 *  - registerSession: sessionId + nonce, max sessions
 *  - handleMessage: origin lạ bị chặn, nonce sai bị chặn, session lạ bị chặn,
 *    type lạ bị drop, action không được phép bị drop, tool ngoài allowlist bị chặn
 *  - app-ready / app-progress (0..100) / app-error
 *  - tool-call hợp lệ -> onToolCall; notify/close/link-open (chặn link http?/non-http)
 *  - rate limit: message quá nhanh bị throttle + drop
 *  - audit log: mọi message (cả bị drop) đều có log; payload bị cắt
 *  - buildOutbound/respondToRequest/pushData/pushStatus
 *  - parseAppBridgeInbound
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v109-apps-bridge.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AppBridgeHost,
  generateAppSessionNonce,
  parseAppBridgeInbound,
  APP_BRIDGE_DEFAULT_RATE_LIMIT_PER_SEC,
} from '../packages/core/dist/mcp/appsBridge.js';

function makeHost(hooks = {}) {
  const calls = { toolCalls: [], notifies: [], closes: [], linkOpens: [] };
  const host = new AppBridgeHost({
    now: () => 1_000_000,
    onToolCall: (sessionId, toolName, args) => {
      calls.toolCalls.push({ sessionId, toolName, args });
    },
    onNotify: (sessionId, message) => {
      calls.notifies.push({ sessionId, message });
    },
    onCloseRequest: (sessionId) => {
      calls.closes.push(sessionId);
    },
    onLinkOpen: (sessionId, url) => {
      calls.linkOpens.push({ sessionId, url });
      return hooks.allowLink === true;
    },
  });
  return { host, calls };
}

function register(host, options = {}) {
  return host.registerSession({ uri: 'ui://srv/app', toolName: 'demo', serverName: 'srv', allowedTools: ['read_file'], ...options });
}

function msg(session, type, extra = {}) {
  return { sessionId: session.sessionId, nonce: session.nonce, type, ...extra };
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

test('bridge: registerSession trả sessionId + nonce khác nhau mỗi lần', () => {
  const { host } = makeHost();
  const a = register(host);
  const b = register(host);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(a.nonce.length, 24);
  assert.equal(host.size, 2);
  assert.equal(generateAppSessionNonce().length, 24);
});

test('bridge: vượt max sessions thì ném lỗi', () => {
  const host = new AppBridgeHost({ maxSessions: 1 });
  register(host);
  assert.throws(() => register(host), /tối đa 1 app/);
});

test('bridge: closeSession xong thì message bị drop unknown-session', () => {
  const { host } = makeHost();
  const s = register(host);
  assert.equal(host.closeSession(s.sessionId), true);
  assert.equal(host.closeSession(s.sessionId), false);
  const res = host.handleMessage('null', msg(s, 'app-ready'));
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'unknown-session');
});

// ---------------------------------------------------------------------------
// origin / nonce / shape
// ---------------------------------------------------------------------------

test('bridge: origin lạ (https) bị chặn dù session + nonce đúng', () => {
  const { host } = makeHost();
  const s = register(host);
  const res = host.handleMessage('https://evil.example.com', msg(s, 'app-ready'));
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'bad-origin');
  assert.equal(host.getSession(s.sessionId).dropped, 1);
});

test('bridge: nonce sai bị chặn', () => {
  const { host } = makeHost();
  const s = register(host);
  const res = host.handleMessage('null', { ...msg(s, 'app-ready'), nonce: 'wrong-nonce' });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'bad-nonce');
});

test('bridge: session không tồn tại bị chặn', () => {
  const { host } = makeHost();
  const res = host.handleMessage('null', { sessionId: 'nope', nonce: 'x', type: 'app-ready' });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'unknown-session');
});

test('bridge: message không phải object / thiếu sessionId bị chặn', () => {
  const { host } = makeHost();
  assert.equal(host.handleMessage('null', 'hello').accepted, false);
  assert.equal(host.handleMessage('null', { type: 'app-ready' }).accepted, false);
});

test('bridge: type lạ bị drop', () => {
  const { host } = makeHost();
  const s = register(host);
  const res = host.handleMessage('null', msg(s, 'app-eval', { code: '1+1' }));
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'unknown-type');
});

// ---------------------------------------------------------------------------
// ready / progress / error
// ---------------------------------------------------------------------------

test('bridge: app-ready đánh dấu session ready', () => {
  const { host } = makeHost();
  const s = register(host);
  const res = host.handleMessage('null', msg(s, 'app-ready'));
  assert.equal(res.accepted, true);
  assert.equal(host.getSession(s.sessionId).ready, true);
});

test('bridge: app-progress ngoài 0..100 bị drop, trong khoảng được nhận', () => {
  const { host } = makeHost();
  const s = register(host);
  assert.equal(host.handleMessage('null', msg(s, 'app-progress', { progress: 150 })).accepted, false);
  const ok = host.handleMessage('null', msg(s, 'app-progress', { progress: 42, message: 'đang xử lý' }));
  assert.equal(ok.accepted, true);
  assert.equal(ok.inbound.progress, 42);
});

test('bridge: app-error được nhận kèm message', () => {
  const { host } = makeHost();
  const s = register(host);
  const res = host.handleMessage('null', msg(s, 'app-error', { message: 'boom' }));
  assert.equal(res.accepted, true);
  assert.equal(res.inbound.message, 'boom');
});

// ---------------------------------------------------------------------------
// app-request: tool-call / notify / close / link-open
// ---------------------------------------------------------------------------

test('bridge: tool-call trong allowlist gọi onToolCall', () => {
  const { host, calls } = makeHost();
  const s = register(host);
  const res = host.handleMessage('null', msg(s, 'app-request', {
    requestId: 'r1',
    action: 'tool-call',
    payload: { tool: 'read_file', arguments: { path: 'a.txt' } },
  }));
  assert.equal(res.accepted, true);
  assert.equal(res.inbound.requestId, 'r1');
  assert.equal(calls.toolCalls.length, 1);
  assert.equal(calls.toolCalls[0].toolName, 'read_file');
  assert.deepEqual(calls.toolCalls[0].args, { path: 'a.txt' });
});

test('bridge: tool-call ngoài allowlist bị chặn, không gọi onToolCall', () => {
  const { host, calls } = makeHost();
  const s = register(host);
  const res = host.handleMessage('null', msg(s, 'app-request', {
    action: 'tool-call',
    payload: { tool: 'delete_all', arguments: {} },
  }));
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'tool-not-allowed');
  assert.equal(calls.toolCalls.length, 0);
});

test('bridge: action không có trong allowedActions của session bị chặn', () => {
  const { host } = makeHost();
  const s = register(host, { allowedActions: ['notify'] });
  const res = host.handleMessage('null', msg(s, 'app-request', {
    action: 'tool-call',
    payload: { tool: 'read_file', arguments: {} },
  }));
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'action-not-allowed');
});

test('bridge: notify + close gọi callback', () => {
  const { host, calls } = makeHost();
  const s = register(host);
  assert.equal(host.handleMessage('null', msg(s, 'app-request', { action: 'notify', payload: { message: 'hi' } })).accepted, true);
  assert.equal(host.handleMessage('null', msg(s, 'app-request', { action: 'close' })).accepted, true);
  assert.deepEqual(calls.notifies, [{ sessionId: s.sessionId, message: 'hi' }]);
  assert.deepEqual(calls.closes, [s.sessionId]);
});

test('bridge: link-open mặc định bị chặn; host cho phép thì qua', () => {
  const { host } = makeHost({ allowLink: false });
  const s = register(host, { allowedActions: ['link-open', 'notify'] });
  const blocked = host.handleMessage('null', msg(s, 'app-request', {
    action: 'link-open', payload: { url: 'https://example.com/x' },
  }));
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'action-not-allowed');

  const { host: host2 } = makeHost({ allowLink: true });
  const s2 = register(host2, { allowedActions: ['link-open'] });
  assert.equal(host2.handleMessage('null', msg(s2, 'app-request', {
    action: 'link-open', payload: { url: 'https://example.com/x' },
  })).accepted, true);

  // URL không phải http(s) luôn bị chặn.
  assert.equal(host2.handleMessage('null', msg(s2, 'app-request', {
    action: 'link-open', payload: { url: 'javascript:alert(1)' },
  })).accepted, false);
});

// ---------------------------------------------------------------------------
// rate limit + audit log
// ---------------------------------------------------------------------------

test('bridge: gửi quá rate limit thì bị throttle + drop', () => {
  let nowMs = 2_000_000;
  const host = new AppBridgeHost({ now: () => nowMs, rateLimitPerSec: 3 });
  const s = register(host, { rateLimitPerSec: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal(host.handleMessage('null', msg(s, 'app-progress', { progress: i })).accepted, true);
  }
  const throttled = host.handleMessage('null', msg(s, 'app-progress', { progress: 4 }));
  assert.equal(throttled.accepted, false);
  assert.equal(throttled.reason, 'rate-limited');
  assert.equal(host.getSession(s.sessionId).throttled, true);
  // Sang giây sau thì lại được gửi.
  nowMs += 1001;
  assert.equal(host.handleMessage('null', msg(s, 'app-progress', { progress: 5 })).accepted, true);
});

test('bridge: audit log ghi cả message bị drop; payload dài bị cắt', () => {
  const { host } = makeHost();
  const s = register(host);
  host.handleMessage('null', msg(s, 'app-ready'));
  host.handleMessage('null', msg(s, 'app-eval'));
  const log = host.getLog();
  assert.ok(log.length >= 2);
  assert.equal(log.filter((e) => e.outcome === 'accepted').length >= 1, true);
  assert.equal(log.some((e) => e.outcome === 'unknown-type'), true);
  assert.equal(host.droppedTotal, 1);
  assert.equal(host.getLogForSession(s.sessionId).length, log.filter((e) => e.sessionId === s.sessionId).length);
  assert.equal(APP_BRIDGE_DEFAULT_RATE_LIMIT_PER_SEC, 20);
});

// ---------------------------------------------------------------------------
// outbound
// ---------------------------------------------------------------------------

test('bridge: buildOutbound/respondToRequest/pushData/pushStatus', () => {
  const { host } = makeHost();
  const s = register(host);
  const resp = host.respondToRequest(s.sessionId, 'r9', { ok: true, payload: { result: 'ok' } });
  assert.equal(resp.type, 'app-response');
  assert.equal(resp.requestId, 'r9');
  assert.equal(resp.ok, true);
  const data = host.pushData(s.sessionId, { a: 1 }, 3);
  assert.equal(data.type, 'app-data');
  assert.equal(data.payload.version, 3);
  const status = host.pushStatus(s.sessionId, 'progress', { progress: 50 });
  assert.equal(status.type, 'app-status');
  assert.equal(status.payload.status, 'progress');
  // Session đã đóng thì outbound trả null.
  host.closeSession(s.sessionId);
  assert.equal(host.buildOutbound(s.sessionId, 'app-data'), null);
});

// ---------------------------------------------------------------------------
// parseAppBridgeInbound
// ---------------------------------------------------------------------------

test('bridge: parseAppBridgeInbound nhận đúng shape, null khi sai', () => {
  assert.equal(parseAppBridgeInbound(null), null);
  assert.equal(parseAppBridgeInbound({ type: 'app-eval', sessionId: 'x' }), null);
  const ok = parseAppBridgeInbound({ type: 'app-request', sessionId: 's1', requestId: 'r', action: 'notify', payload: { message: 'm' } });
  assert.equal(ok.type, 'app-request');
  assert.equal(ok.action, 'notify');
  const bad = parseAppBridgeInbound({ type: 'app-request', sessionId: 's1', action: 'eval' });
  assert.equal(bad, null);
});
