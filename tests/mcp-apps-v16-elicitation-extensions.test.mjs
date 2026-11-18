/**
 * Test v1.36 T3: MCP Apps v16 — URL-mode elicitation + extension negotiation (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v16-elicitation-extensions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UrlElicitationManagerV16,
  assertFormModeAllowed,
  checkFormModeAllowed,
  suggestUrlPurpose,
  validateElicitationUrl,
} from '../packages/core/dist/mcp/elicitationUrlV16.js';
import {
  EXTENSION_APPS_ID,
  EXTENSION_TASKS_ID,
  buildExtensionsField,
  compareExtensionVersions,
  describeNegotiation,
  extensionsFromDiscover,
  getKnownExtension,
  isExtensionEnabled,
  negotiateExtensions,
  parseExtensionsField,
  requireExtension,
  versionAtLeast,
} from '../packages/core/dist/mcp/extensionsV16.js';

const HOSTS = ['accounts.google.com', 'github.com'];

test('elicitation url: validate chấp nhận https trong allowlist, từ chối http / host lạ / userinfo / quá dài', () => {
  assert.deepEqual(
    validateElicitationUrl('https://accounts.google.com/o/oauth2/auth?client_id=x', HOSTS),
    { host: 'accounts.google.com' },
  );
  assert.deepEqual(
    validateElicitationUrl('https://sub.github.com/login/oauth', HOSTS),
    { host: 'sub.github.com' },
  );
  assert.throws(
    () => validateElicitationUrl('http://accounts.google.com/auth', HOSTS),
    /phải dùng https/,
  );
  assert.throws(
    () => validateElicitationUrl('https://evil.example.com/auth', HOSTS),
    /không nằm trong allowlist/,
  );
  assert.throws(
    () => validateElicitationUrl('https://user:pass@github.com/auth', HOSTS),
    /credential trong URL/,
  );
  assert.throws(
    () => validateElicitationUrl('javascript:alert(1)', HOSTS),
    /phải dùng https/,
  );
  assert.throws(() => validateElicitationUrl('not a url', HOSTS), /không hợp lệ/);
  assert.throws(
    () => validateElicitationUrl(`https://github.com/${'a'.repeat(2100)}`, HOSTS),
    /vượt giới hạn/,
  );
});

test('elicitation form guard: trường thường qua, password/apiKey/token/payment đều bị cấm', () => {
  const ok = checkFormModeAllowed([
    { name: 'projectName', schema: { type: 'string' } },
    { name: 'count', schema: { type: 'integer' } },
    { name: 'subscribe', schema: { type: 'boolean' } },
  ]);
  assert.equal(ok.allowed, true);
  assert.deepEqual(ok.violations, []);
  assert.doesNotThrow(() =>
    assertFormModeAllowed([{ name: 'nickname', schema: { type: 'string' } }]),
  );

  const bad = checkFormModeAllowed([
    { name: 'projectName', schema: { type: 'string' } },
    { name: 'apiKey', schema: { type: 'string' } },
    { name: 'password', schema: { type: 'string', format: 'password' } },
    { name: 'cardNumber', schema: { type: 'string' } },
    { name: 'accessToken', schema: { type: 'string' } },
  ]);
  assert.equal(bad.allowed, false);
  assert.equal(bad.violations.length, 4);
  assert.deepEqual(
    bad.violations.map((v) => v.field),
    ['apiKey', 'password', 'cardNumber', 'accessToken'],
  );
  assert.ok(bad.violations.every((v) => v.mustUse === 'url'));
  assert.throws(() => assertFormModeAllowed([
    { name: 'apiKey', schema: { type: 'string' } },
  ]), /Form mode bị cấm cho secret.*apiKey/);

  // Trường con nhạy cảm trong properties cũng cấm cả form.
  const nested = checkFormModeAllowed([
    {
      name: 'login',
      schema: {
        type: 'object',
        properties: { username: { type: 'string' }, accessToken: { type: 'string' } },
      },
    },
  ]);
  assert.equal(nested.allowed, false);
  assert.equal(nested.violations[0].field, 'login.accessToken');
});

test('elicitation suggestUrlPurpose: payment / refresh / consent / oauth-signin', () => {
  assert.equal(suggestUrlPurpose('cardNumber'), 'payment');
  assert.equal(suggestUrlPurpose('paymentMethod'), 'payment');
  assert.equal(suggestUrlPurpose('refreshToken'), 'credential-refresh');
  assert.equal(suggestUrlPurpose('consentScope'), 'consent');
  assert.equal(suggestUrlPurpose('apiKey'), 'oauth-signin');
  assert.equal(suggestUrlPurpose('password'), 'oauth-signin');
});

test('elicitation manager: tạo phiên → cấp token → hoàn thành; token dùng lại thì ném', () => {
  let nowMs = 1_000_000;
  const manager = new UrlElicitationManagerV16({
    allowedHosts: HOSTS,
    callbackSecret: 'callback-secret-1234567890',
    now: () => nowMs,
  });
  assert.throws(
    () => new UrlElicitationManagerV16({ allowedHosts: [] }),
    /allowlist host/,
  );
  const session = manager.createSession({
    purpose: 'oauth-signin',
    url: 'https://accounts.google.com/o/oauth2/auth',
    serverName: 'github-server',
    prompt: 'Đăng nhập Google để tiếp tục.',
  });
  assert.equal(session.status, 'pending');
  assert.equal(session.host, 'accounts.google.com');
  assert.equal(manager.pendingSessions().length, 1);
  const token = manager.issueCallbackToken(session.id);
  assert.ok(token.startsWith('v16url.'));
  const done = manager.completeByCallback(token, 'txn-123');
  assert.equal(done.status, 'completed');
  assert.equal(done.reference, 'txn-123');
  assert.equal(typeof done.resolvedAtMs, 'number');
  // Token single-use: dùng lại thì ném.
  assert.throws(() => manager.completeByCallback(token), /đã dùng/);
  // Phiên đã xong thì không cấp token mới, không huỷ được.
  assert.throws(() => manager.issueCallbackToken(session.id), /đã completed/);
  assert.throws(() => manager.cancelSession(session.id), /đã completed/);
  assert.equal(manager.pendingSessions().length, 0);
  void nowMs;
});

test('elicitation manager: token sai chữ ký / sai định dạng thì ném; phiên hết hạn thì sweep', () => {
  let nowMs = 2_000_000;
  const manager = new UrlElicitationManagerV16({
    allowedHosts: HOSTS,
    callbackSecret: 'callback-secret-1234567890',
    ttlMs: 60_000,
    now: () => nowMs,
  });
  const session = manager.createSession({
    purpose: 'payment',
    url: 'https://github.com/sponsors/checkout',
    serverName: 'billing',
    prompt: 'Thanh toán để tiếp tục.',
  });
  const token = manager.issueCallbackToken(session.id);
  assert.throws(() => manager.completeByCallback(`${token}tampered`), /chữ ký/);
  assert.throws(() => manager.completeByCallback('garbage-token'), /định dạng/);
  // Hết hạn: complete ném expired, sweep chuyển trạng thái.
  nowMs += 120_000;
  assert.throws(() => manager.completeByCallback(token), /hết hạn/);
  assert.equal(manager.getSession(session.id).status, 'expired');

  const second = manager.createSession({
    purpose: 'consent',
    url: 'https://github.com/settings/apps',
    serverName: 'consent-server',
    prompt: 'Cho phép truy cập?',
  });
  nowMs += 120_000;
  assert.equal(manager.sweepExpired(), 1);
  assert.equal(manager.getSession(second.id).status, 'expired');
  assert.equal(manager.sweepExpired(), 0);
});

test('elicitation manager: cancel + fail; tạo phiên URL xấu thì ném', () => {
  const manager = new UrlElicitationManagerV16({ allowedHosts: HOSTS });
  assert.throws(
    () =>
      manager.createSession({
        purpose: 'oauth-signin',
        url: 'http://evil.example.com/login',
        serverName: 'x',
        prompt: 'x',
      }),
    /https/,
  );
  const a = manager.createSession({
    purpose: 'consent',
    url: 'https://github.com/login',
    serverName: 'x',
    prompt: 'Đồng ý?',
  });
  const cancelled = manager.cancelSession(a.id, 'user đóng trang');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reason, 'user đóng trang');
  const b = manager.createSession({
    purpose: 'payment',
    url: 'https://github.com/pay',
    serverName: 'x',
    prompt: 'Trả tiền',
  });
  const failed = manager.failSession(b.id, 'trang đích lỗi 500');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'trang đích lỗi 500');
  assert.throws(() => manager.cancelSession('no-such-id'), /Không tìm thấy phiên/);
  assert.throws(() => manager.completeByCallback('v16url.aaaa.bbbb'), /chữ ký|Không tìm thấy/);
});

test('extensions: registry đã biết Apps + Tasks; parse field chấp nhận string[] và object[]', () => {
  const apps = getKnownExtension(EXTENSION_APPS_ID);
  assert.equal(apps.name, 'MCP Apps');
  assert.equal(apps.spec, 'SEP-1865 (ổn định 01/2026)');
  const tasks = getKnownExtension(EXTENSION_TASKS_ID);
  assert.equal(tasks.name, 'Tasks');
  assert.equal(getKnownExtension('io.example/unknown'), undefined);

  const fromStrings = parseExtensionsField([EXTENSION_APPS_ID, EXTENSION_TASKS_ID]);
  assert.equal(fromStrings.declarations.length, 2);
  assert.deepEqual(fromStrings.skipped, []);
  const fromObjects = parseExtensionsField([
    { id: EXTENSION_APPS_ID, version: '2026-01-01' },
    { id: 123 },
    null,
  ]);
  assert.equal(fromObjects.declarations.length, 1);
  assert.equal(fromObjects.declarations[0].version, '2026-01-01');
  assert.equal(fromObjects.skipped.length, 2);
  assert.deepEqual(parseExtensionsField('not-an-array').declarations, []);
  const built = buildExtensionsField([
    { id: EXTENSION_APPS_ID, version: '2026-01-01' },
    { id: EXTENSION_APPS_ID, version: '2026-01-01' },
    { id: '' },
  ]);
  assert.equal(built.length, 1, 'trùng id và id rỗng bị loại');
});

test('extensions: compare version ngày + semver; versionAtLeast', () => {
  assert.equal(compareExtensionVersions('2026-01-01', '2026-01-01'), 0);
  assert.equal(compareExtensionVersions('2026-07-28', '2026-01-01'), 1);
  assert.equal(compareExtensionVersions('2025-11-25', '2026-01-01'), -1);
  assert.equal(compareExtensionVersions('1.2.3', '1.2.2'), 1);
  assert.equal(compareExtensionVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareExtensionVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareExtensionVersions('weird', 'also-weird'), 0);
  assert.equal(versionAtLeast('2026-07-28', '2026-01-01'), true);
  assert.equal(versionAtLeast('2025-11-25', '2026-01-01'), false);
});

test('extensions: negotiate — cả hai phía khai thì bật; thiếu một phía thì tắt (mặc định tắt)', () => {
  const both = negotiateExtensions(
    [{ id: EXTENSION_APPS_ID, version: '2026-01-01' }],
    [{ id: EXTENSION_APPS_ID, version: '2026-01-01' }],
  );
  assert.deepEqual(both.enabledIds, [EXTENSION_APPS_ID]);
  assert.equal(both.anyEnabled, true);
  assert.equal(isExtensionEnabled(both, EXTENSION_APPS_ID), true);
  assert.equal(isExtensionEnabled(both, EXTENSION_TASKS_ID), false);
  assert.equal(both.extensions[0].version, '2026-01-01');

  const serverOnly = negotiateExtensions([], [{ id: EXTENSION_APPS_ID }]);
  assert.equal(serverOnly.anyEnabled, false);
  assert.deepEqual(serverOnly.notRequestedByClient, [EXTENSION_APPS_ID]);

  const clientOnly = negotiateExtensions(
    [{ id: EXTENSION_APPS_ID }],
    [{ id: EXTENSION_TASKS_ID }],
  );
  assert.equal(clientOnly.anyEnabled, false);
  assert.deepEqual(clientOnly.unsupportedByServer, [EXTENSION_APPS_ID]);
  assert.deepEqual(clientOnly.notRequestedByClient, [EXTENSION_TASKS_ID]);

  const none = negotiateExtensions([], []);
  assert.equal(none.anyEnabled, false);
  assert.equal(describeNegotiation(none), 'Không có extension nào được yêu cầu.');
  assert.match(describeNegotiation(both), /MCP Apps: bật/);
});

test('extensions: negotiate — version server thấp hơn tối thiểu thì tắt; extension lạ mặc định tắt', () => {
  const lowVersion = negotiateExtensions(
    [{ id: EXTENSION_APPS_ID, version: '2026-01-01' }],
    [{ id: EXTENSION_APPS_ID, version: '2025-06-18' }],
  );
  assert.equal(lowVersion.enabledIds.length, 0);
  assert.match(lowVersion.extensions[0].reason, /thấp hơn tối thiểu/);

  const unknown = negotiateExtensions(
    [{ id: 'io.example/experimental' }],
    [{ id: 'io.example/experimental' }],
  );
  assert.equal(unknown.enabledIds.length, 0);
  assert.deepEqual(unknown.unknownIds, ['io.example/experimental']);
  assert.match(unknown.extensions[0].reason, /mặc định tắt/);
  const unknownAllowed = negotiateExtensions(
    [{ id: 'io.example/experimental' }],
    [{ id: 'io.example/experimental' }],
    { allowUnknown: true },
  );
  assert.deepEqual(unknownAllowed.enabledIds, ['io.example/experimental']);
});

test('extensions: extensionsFromDiscover trích từ document discover; thiếu field thì rỗng', () => {
  const fromDoc = extensionsFromDiscover({
    protocolVersion: '2026-07-28',
    supportedVersions: ['2026-07-28'],
    capabilities: { tools: {} },
    serverInfo: { name: 'demo', version: '1.0.0' },
    extensions: ['io.modelcontextprotocol/ui', { id: 'io.modelcontextprotocol/tasks', version: '2026-07-28' }],
  });
  assert.deepEqual(fromDoc, [
    { id: 'io.modelcontextprotocol/ui' },
    { id: 'io.modelcontextprotocol/tasks', version: '2026-07-28' },
  ]);
  assert.deepEqual(
    extensionsFromDiscover({
      protocolVersion: '2026-07-28',
      capabilities: {},
      serverInfo: { name: 'old', version: '0.9.0' },
    }),
    [],
  );
  // Nối discover → negotiate: server khai Apps, client xin Apps → bật.
  const negotiated = negotiateExtensions(
    [{ id: EXTENSION_APPS_ID }],
    fromDoc,
  );
  assert.deepEqual(negotiated.enabledIds, [EXTENSION_APPS_ID]);
});

test('extensions: requireExtension ném khi chưa bật, qua khi đã bật', () => {
  const off = negotiateExtensions([], [{ id: EXTENSION_APPS_ID }]);
  assert.throws(
    () => requireExtension(off, EXTENSION_APPS_ID, 'mở app demo'),
    /cần extension MCP Apps.*chưa được thương lượng bật/,
  );
  const on = negotiateExtensions(
    [{ id: EXTENSION_APPS_ID }],
    [{ id: EXTENSION_APPS_ID }],
  );
  assert.doesNotThrow(() => requireExtension(on, EXTENSION_APPS_ID, 'mở app demo'));
});
