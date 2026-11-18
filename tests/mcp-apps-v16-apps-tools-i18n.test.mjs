/**
 * Test v1.36 T3: MCP Apps v16 — Apps pipeline + server/discover + tools + i18n (node:test).
 * Local only, no network (fake transport + scripted server).
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-apps-v16-apps-tools-i18n.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AppsHostV16,
  buildSandboxPolicyV16,
  negotiateDisplayModeV16,
  sha256HexV16,
} from '../packages/core/dist/mcp/appsV16.js';
import {
  DiscoverCacheV16,
  buildServerDiscoverDocumentV16,
  checkVersionCompatibility,
  discoverFromTransportV16,
  pickCommonProtocolVersion,
} from '../packages/core/dist/mcp/serverDiscoverV16.js';
import { negotiateExtensions } from '../packages/core/dist/mcp/extensionsV16.js';
import {
  MCP_APPS_V16_TOOL_NAMES,
  MCP_APPS_V16_TOOLS,
  createMcpAppsV16State,
  createMcpAppsV16Tools,
} from '../packages/tools/dist/mcpAppsV16Tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const MCP_APPS_V16_KEYS = [
  'mcpApps.v16.appsDeclareTitle',
  'mcpApps.v16.appsNotReady',
  'mcpApps.v16.appsOpenTitle',
  'mcpApps.v16.appsReady',
  'mcpApps.v16.appsReviewRequired',
  'mcpApps.v16.daysLeft',
  'mcpApps.v16.deprecationTitle',
  'mcpApps.v16.deprecationWarning',
  'mcpApps.v16.discoverTitle',
  'mcpApps.v16.elicitUrlTitle',
  'mcpApps.v16.extensionsTitle',
  'mcpApps.v16.extensionOff',
  'mcpApps.v16.formCheckTitle',
  'mcpApps.v16.inputRequired',
  'mcpApps.v16.integrityMismatch',
  'mcpApps.v16.mrtrTitle',
  'mcpApps.v16.negotiationSummary',
  'mcpApps.v16.oauthTitle',
  'mcpApps.v16.requestStateInvalid',
  'mcpApps.v16.secretForbiddenForm',
  'mcpApps.v16.sessionExpired',
  'mcpApps.v16.statelessTitle',
  'mcpApps.v16.title',
  'mcpApps.v16.useUrlMode',
];

const HTML = '<!doctype html><html><body><h1>Dashboard</h1></body></html>';
const MANIFEST = {
  name: 'dashboard',
  version: '1.2.0',
  server: 'demo',
  resourceUri: 'ui://demo/dashboard',
  capabilities: [],
  sandboxProfile: 'display-only',
  cspProfile: 'strict',
};

function negotiatedAppsOn() {
  return negotiateExtensions(
    [{ id: 'io.modelcontextprotocol/ui' }],
    [{ id: 'io.modelcontextprotocol/ui' }],
  );
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function runTool(tools, name, args) {
  const out = await toolByName(tools, name).execute(args);
  return JSON.parse(out);
}

test('apps v16: sha256 đúng chuẩn; sandbox policy theo profile', () => {
  assert.equal(
    sha256HexV16('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const display = buildSandboxPolicyV16('display-only', 'strict');
  assert.equal(display.sandboxAttribute, '');
  assert.match(display.cspHeader, /default-src 'none'/);
  assert.equal(display.warnings.length, 0);
  const interactive = buildSandboxPolicyV16('interactive', 'strict');
  assert.equal(interactive.sandboxAttribute, 'allow-scripts allow-same-origin');
  const privileged = buildSandboxPolicyV16('privileged', 'network');
  assert.match(privileged.sandboxAttribute, /allow-forms/);
  assert.match(privileged.cspHeader, /connect-src https:/);
  assert.ok(privileged.warnings.length >= 1);
  assert.throws(() => buildSandboxPolicyV16('no-such', 'strict'), /Sandbox profile/);
  assert.throws(() => buildSandboxPolicyV16('interactive', 'no-such'), /CSP profile/);
});

test('apps v16: negotiate display mode — display-only fullscreen hạ xuống inline; mode lạ về text-only', () => {
  const downgraded = negotiateDisplayModeV16('fullscreen', 'display-only');
  assert.equal(downgraded.mode, 'inline');
  assert.equal(downgraded.downgraded, true);
  assert.match(downgraded.reason, /display-only/);
  const ok = negotiateDisplayModeV16('fullscreen', 'interactive');
  assert.equal(ok.mode, 'fullscreen');
  assert.equal(ok.downgraded, false);
  const unknown = negotiateDisplayModeV16('hologram', 'interactive');
  assert.equal(unknown.mode, 'text-only');
  assert.equal(unknown.downgraded, true);
  const textOnly = negotiateDisplayModeV16('text-only', 'interactive');
  assert.equal(textOnly.mode, 'text-only');
  assert.equal(textOnly.downgraded, false);
  const pipUnsupported = negotiateDisplayModeV16('pip', 'interactive', ['inline', 'text-only']);
  assert.equal(pipUnsupported.mode, 'text-only');
});

test('apps v16 host: declare → prefetch → review → open đủ pipeline; lỗi từng bước rõ ràng', () => {
  const host = new AppsHostV16();
  // Prefetch khi chưa declare thì ném.
  assert.throws(() => host.prefetchTemplate('dashboard', HTML), /declare trước/);
  const declared = host.declareTemplate(MANIFEST);
  assert.equal(declared.status, 'declared');
  assert.equal(declared.manifest.name, 'dashboard');
  // Khai báo lại khác version thì ném.
  assert.throws(
    () => host.declareTemplate({ ...MANIFEST, version: '2.0.0' }),
    /gỡ template cũ trước/,
  );
  // Manifest xấu thì ném (tên không kebab-case).
  assert.throws(() => host.declareTemplate({ ...MANIFEST, name: 'Bad Name' }), /kebab-case/);
  // Review khi chưa prefetch thì ném.
  assert.throws(() => host.reviewTemplate('dashboard', 'approved', 'ada'), /prefetch/);
  // Mở khi chưa ready thì ném (kể cả extension đã bật).
  assert.throws(
    () => host.openApp({ name: 'dashboard', html: HTML, negotiation: negotiatedAppsOn() }),
    /chưa sẵn sàng/,
  );
  // Prefetch HTML load script ngoài thì ném.
  assert.throws(
    () =>
      host.prefetchTemplate(
        'dashboard',
        '<!doctype html><html><head><script src="https://evil.example/x.js"></script></head></html>',
      ),
    /script từ URL ngoài/,
  );
  const prefetched = host.prefetchTemplate('dashboard', HTML);
  assert.equal(prefetched.status, 'prefetched');
  assert.equal(prefetched.htmlSha256, sha256HexV16(HTML));
  // Mở khi extension chưa negotiate thì ném trước cả trạng thái ready.
  const host2 = new AppsHostV16();
  host2.declareTemplate(MANIFEST);
  host2.prefetchTemplate('dashboard', HTML);
  host2.reviewTemplate('dashboard', 'approved', 'ada', 'looks fine');
  const off = negotiateExtensions([], [{ id: 'io.modelcontextprotocol/ui' }]);
  assert.throws(
    () => host2.openApp({ name: 'dashboard', html: HTML, negotiation: off }),
    /chưa được thương lượng bật/,
  );
  // Review reject → không mở được.
  const rejected = host.reviewTemplate('dashboard', 'rejected', 'ada', 'nghi ngờ');
  assert.equal(rejected.status, 'review-rejected');
  assert.throws(
    () => host.openApp({ name: 'dashboard', html: HTML, negotiation: negotiatedAppsOn() }),
    /chưa sẵn sàng/,
  );
  // Prefetch lại reset review → approve → mở thành công.
  host.prefetchTemplate('dashboard', HTML);
  const ready = host.reviewTemplate('dashboard', 'approved', 'ada', 'ok');
  assert.equal(ready.status, 'ready');
  const session = host.openApp({
    name: 'dashboard',
    html: HTML,
    negotiation: negotiatedAppsOn(),
    requestedDisplayMode: 'inline',
  });
  assert.equal(session.appName, 'dashboard');
  assert.equal(session.server, 'demo');
  assert.equal(session.displayMode, 'inline');
  assert.equal(session.htmlSha256, sha256HexV16(HTML));
  assert.equal(host.getSession(session.id).appName, 'dashboard');
  assert.equal(host.openSessionCount(), 1);
  assert.equal(host.closeSession(session.id), true);
  assert.equal(host.openSessionCount(), 0);
  assert.equal(host.getTemplate('dashboard').openCount, 1);
});

test('apps v16 host: HTML khác hash prefetch thì từ chối; privileged cần note tường minh', () => {
  const host = new AppsHostV16();
  host.declareTemplate(MANIFEST);
  host.prefetchTemplate('dashboard', HTML);
  host.reviewTemplate('dashboard', 'approved', 'ada');
  const tampered = '<!doctype html><html><body><h1>EVIL</h1></body></html>';
  assert.throws(
    () => host.openApp({ name: 'dashboard', html: tampered, negotiation: negotiatedAppsOn() }),
    /không khớp hash/,
  );

  const priv = new AppsHostV16();
  priv.declareTemplate({
    ...MANIFEST,
    name: 'admin-panel',
    resourceUri: 'ui://demo/admin-panel',
    capabilities: ['tools-call'],
    sandboxProfile: 'privileged',
    cspProfile: 'network',
  });
  priv.prefetchTemplate('admin-panel', HTML);
  priv.reviewTemplate('admin-panel', 'approved', 'ada', 'ok chung chung');
  assert.throws(
    () => priv.openApp({ name: 'admin-panel', html: HTML, negotiation: negotiatedAppsOn() }),
    /privileged.*ghi chú tường minh/,
  );
  priv.prefetchTemplate('admin-panel', HTML);
  priv.reviewTemplate('admin-panel', 'approved', 'ada', 'privileged: đã kiểm tra forms/popups');
  const session = priv.openApp({ name: 'admin-panel', html: HTML, negotiation: negotiatedAppsOn() });
  assert.equal(session.appName, 'admin-panel');
  assert.ok(session.sandboxPolicy.warnings.length >= 1);
});

test('apps v16 host: cache LRU evict template ít dùng nhất khi vượt giới hạn', () => {
  const host = new AppsHostV16({ maxTemplates: 2, maxCacheBytes: 10_000_000 });
  for (const name of ['app-one', 'app-two', 'app-three']) {
    host.declareTemplate({ ...MANIFEST, name, resourceUri: `ui://demo/${name}` });
    host.prefetchTemplate(name, HTML);
  }
  assert.equal(host.templateCount(), 2);
  assert.equal(host.getTemplate('app-one'), undefined, 'app-one ít dùng nhất bị evict');
  assert.ok(host.getTemplate('app-two'));
  assert.ok(host.getTemplate('app-three'));
  assert.equal(host.removeTemplate('app-two'), true);
  assert.equal(host.removeTemplate('app-two'), false);
});

test('server/discover v16: build document hợp lệ; version chung; cache stale-while-revalidate', async () => {
  const doc = buildServerDiscoverDocumentV16({
    serverName: 'demo',
    serverVersion: '1.0.0',
    capabilities: { tools: {}, apps: {} },
    extensions: [{ id: 'io.modelcontextprotocol/ui', version: '2026-01-01' }],
    endpoints: [{ url: 'https://a.example/rpc', role: 'rpc', health: 'healthy' }],
    note: 'demo server',
  });
  assert.equal(doc.protocolVersion, '2026-07-28');
  assert.deepEqual(doc.supportedVersions.slice(0, 1), ['2026-07-28']);
  assert.deepEqual(doc.extensions, ['io.modelcontextprotocol/ui']);
  assert.equal(doc.endpoints[0].health, 'healthy');
  assert.throws(() => buildServerDiscoverDocumentV16({ serverName: '', serverVersion: '1.0.0' }), /serverName/);
  assert.throws(
    () => buildServerDiscoverDocumentV16({ serverName: 'x', serverVersion: '1.0.0', protocolVersion: '1999-01-01' }),
    /không rõ/,
  );

  assert.equal(pickCommonProtocolVersion(['2026-07-28'], ['2026-07-28', '2025-11-25']), '2026-07-28');
  assert.equal(pickCommonProtocolVersion(['2026-07-28'], ['2025-11-25']), null);
  const compat = checkVersionCompatibility(['2026-07-28'], ['2025-11-25']);
  assert.equal(compat.compatible, false);
  assert.match(compat.reason, /Không có protocol version chung/);
  const compatOk = checkVersionCompatibility(['2026-07-28', '2025-11-25'], ['2025-11-25']);
  assert.equal(compatOk.compatible, true);
  assert.equal(compatOk.agreedVersion, '2025-11-25');

  let nowMs = 5_000_000;
  const cache = new DiscoverCacheV16({ ttlMs: 60_000, now: () => nowMs });
  const entry = cache.put('https://a.example/rpc', doc);
  assert.equal(cache.size(), 1);
  assert.equal(cache.getFresh('https://a.example/rpc').fetchedAtMs, entry.fetchedAtMs);
  nowMs += 61_000;
  assert.equal(cache.getFresh('https://a.example/rpc'), null);
  const stale = cache.get('https://a.example/rpc');
  assert.equal(stale.stale, true);
  assert.equal(stale.entry.hits, 3, 'getFresh lần 1 + getFresh hết hạn + get = 3 lần hits');
  assert.equal(cache.get('https://missing.example/rpc'), null);
  nowMs += 3 * 60_000;
  assert.equal(cache.sweep(), 1);
  assert.equal(cache.size(), 0);
});

test('server/discover v16: discoverFromTransport dùng cache, version không tương thích thì ném', async () => {
  let calls = 0;
  const transport = {
    async request(endpointUrl, body) {
      calls += 1;
      assert.equal(body.method, 'server/discover');
      return {
        protocolVersion: '2026-07-28',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: { name: 'demo', version: '1.0.0' },
      };
    },
  };
  const cache = new DiscoverCacheV16();
  const first = await discoverFromTransportV16(transport, 'https://a.example/rpc', { cache });
  assert.equal(first.serverInfo.name, 'demo');
  const second = await discoverFromTransportV16(transport, 'https://a.example/rpc', { cache });
  assert.equal(second, first);
  assert.equal(calls, 1, 'lần 2 dùng cache');

  const oldTransport = {
    async request() {
      return {
        protocolVersion: '2025-11-25',
        supportedVersions: ['2025-11-25'],
        capabilities: {},
        serverInfo: { name: 'old', version: '0.9.0' },
      };
    },
  };
  await assert.rejects(
    () =>
      discoverFromTransportV16(oldTransport, 'https://old.example/rpc', {
        clientSupported: ['2026-07-28'],
      }),
    /Không có protocol version chung/,
  );
});

test('tools v16: 15 tool, tên chỉ [A-Za-z0-9_-], không dấu chấm; needsApproval đúng nhóm', () => {
  assert.equal(MCP_APPS_V16_TOOLS.length, 15);
  assert.deepEqual(
    MCP_APPS_V16_TOOLS.map((t) => t.definition.name),
    [...MCP_APPS_V16_TOOL_NAMES],
  );
  for (const tool of MCP_APPS_V16_TOOLS) {
    assert.match(tool.definition.name, /^[A-Za-z0-9_-]+$/, tool.definition.name);
    assert.equal(tool.definition.name.includes('.'), false);
  }
  const approval = Object.fromEntries(
    MCP_APPS_V16_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(approval['mcp_apps_v16_stateless_call'], true);
  assert.equal(approval['mcp_apps_v16_mrtr_run'], true);
  assert.equal(approval['mcp_apps_v16_elicit_url_create'], true);
  assert.equal(approval['mcp_apps_v16_apps_open'], true);
  assert.equal(approval['mcp_apps_v16_discover'], false);
  assert.equal(approval['mcp_apps_v16_extensions_negotiate'], false);
  assert.equal(approval['mcp_apps_v16_deprecation_report'], false);
  assert.equal(approval['mcp_apps_v16_migrate_check'], false);
  assert.equal(approval['mcp_apps_v16_apps_list'], false);
});

test('tools v16: apps_list liệt kê template theo trạng thái + stats', async () => {
  const state = createMcpAppsV16State();
  const tools = createMcpAppsV16Tools(state);
  const empty = await runTool(tools, 'mcp_apps_v16_apps_list', {});
  assert.equal(empty.stats.templates, 0);
  assert.equal(empty.stats.openSessions, 0);
  assert.deepEqual(empty.templates, []);
  await runTool(tools, 'mcp_apps_v16_apps_declare', {
    name: 'dashboard',
    version: '1.2.0',
    server: 'demo',
    resourceUri: 'ui://demo/dashboard',
    capabilities: [],
    sandboxProfile: 'display-only',
    cspProfile: 'strict',
  });
  await runTool(tools, 'mcp_apps_v16_apps_prefetch', { name: 'dashboard', html: HTML });
  const ready = await runTool(tools, 'mcp_apps_v16_apps_list', { status: 'ready' });
  assert.deepEqual(ready.templates, []);
  const prefetched = await runTool(tools, 'mcp_apps_v16_apps_list', { status: 'prefetched' });
  assert.equal(prefetched.templates.length, 1);
  assert.equal(prefetched.templates[0].manifest.name, 'dashboard');
  assert.equal(prefetched.stats.templates, 1);
  assert.equal(prefetched.stats.byStatus.prefetched, 1);
  assert.equal(prefetched.stats.byStatus.ready, 0);
  assert.ok(prefetched.stats.cachedBytes > 0);
  const noSessions = await runTool(tools, 'mcp_apps_v16_apps_list', { includeSessions: false });
  assert.deepEqual(noSessions.sessions, []);
});

test('tools v16: migrate_check báo blocking + điểm + config đã chuyển đổi', async () => {
  const tools = createMcpAppsV16Tools();
  const legacy = await runTool(tools, 'mcp_apps_v16_migrate_check', {
    role: 'client',
    config: {
      usesInitialize: true,
      usesSessionIdHeader: true,
      hasServerDiscover: false,
      protocolVersion: '2025-11-25',
      deprecatedCapabilities: ['sampling'],
      usesServerInitiatedRequests: true,
      formElicitsSecrets: false,
      usesDynamicClientRegistration: false,
      declaredExtensions: [],
      endpointUrls: ['https://a.example/rpc'],
      name: 'open-bot',
      version: '1.36.0',
    },
  });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.report.ready, false);
  assert.equal(legacy.report.score, 0);
  assert.ok(legacy.report.blocking.some((i) => i.code === 'uses-initialize'));
  assert.ok(legacy.report.blocking.some((i) => i.code === 'uses-server-initiated-requests'));
  assert.equal(legacy.migratedConfig.protocolVersion, '2026-07-28');
  assert.deepEqual(legacy.migratedConfig.endpoints, [{ url: 'https://a.example/rpc' }]);
  assert.ok(legacy.migratedConfig.dropped.some((d) => d.includes('initialize')));
  assert.ok(legacy.checklist.some((s) => s.includes('input_required')));

  const clean = await runTool(tools, 'mcp_apps_v16_migrate_check', {
    role: 'client',
    config: {
      usesInitialize: false,
      usesSessionIdHeader: false,
      hasServerDiscover: true,
      protocolVersion: '2026-07-28',
      endpointUrls: ['https://a.example/rpc'],
    },
  });
  assert.equal(clean.report.ready, true);
  assert.equal(clean.report.score, 100);
  assert.deepEqual(clean.migratedConfig.dropped, []);
});

test('tools v16: discover build + extensions negotiate + form check qua tool', async () => {
  const tools = createMcpAppsV16Tools();
  const built = await runTool(tools, 'mcp_apps_v16_discover', {
    mode: 'build',
    serverName: 'demo',
    serverVersion: '1.0.0',
    capabilities: { tools: {} },
    extensions: ['io.modelcontextprotocol/ui'],
  });
  assert.equal(built.ok, true);
  assert.equal(built.document.protocolVersion, '2026-07-28');
  assert.deepEqual(built.document.extensions, ['io.modelcontextprotocol/ui']);

  const negotiated = await runTool(tools, 'mcp_apps_v16_extensions_negotiate', {
    clientRequested: ['io.modelcontextprotocol/ui', 'io.modelcontextprotocol/tasks'],
    serverSupported: ['io.modelcontextprotocol/ui'],
  });
  assert.equal(negotiated.appsEnabled, true);
  assert.equal(negotiated.tasksEnabled, false);
  assert.match(negotiated.summary, /MCP Apps: bật/);

  const formBad = await runTool(tools, 'mcp_apps_v16_elicit_form_check', {
    fields: [{ name: 'apiKey', schema: { type: 'string' } }],
  });
  assert.equal(formBad.allowed, false);
  assert.equal(formBad.suggestions[0].suggestedPurpose, 'oauth-signin');
  const formOk = await runTool(tools, 'mcp_apps_v16_elicit_form_check', {
    fields: [{ name: 'nickname', schema: { type: 'string' } }],
  });
  assert.equal(formOk.allowed, true);
});

test('tools v16: deprecation report + oauth register (reuse alert) qua tool', async () => {
  const state = createMcpAppsV16State();
  const tools = createMcpAppsV16Tools(state);
  const report = await runTool(tools, 'mcp_apps_v16_deprecation_report', {
    recordMethod: 'sampling/createMessage',
  });
  assert.equal(report.earliestRemoval, '2027-07-28');
  assert.equal(report.rows.length, 3);
  assert.equal(report.rows.find((r) => r.capability === 'sampling').totalCalls, 1);

  const registered = await runTool(tools, 'mcp_apps_v16_oauth_client_register', {
    document: {
      client_id: 'open-bot',
      redirect_uris: ['https://app.example.com/callback'],
      issuer: 'https://accounts.google.com',
    },
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.registered.document.client_id, 'open-bot');

  // Client khác, có DCR cũ khác redirect → reuse alert (không ném ở tool register trực tiếp).
  const reuse = await runTool(tools, 'mcp_apps_v16_oauth_client_register', {
    document: {
      client_id: 'open-bot-2',
      redirect_uris: ['https://app.example.com/callback'],
    },
    priorDcrRedirectUris: ['https://evil.example.com/callback'],
  });
  assert.ok(reuse.reuseAlert);
  assert.deepEqual(reuse.reuseAlert.differingFields, ['redirect_uris']);
});

test('tools v16: elicitation URL create → complete; stateless call + mrtr run qua fake transport', async () => {
  const seen = [];
  const transport = {
    async request(endpointUrl, body) {
      seen.push({ endpointUrl, body });
      if (body.method === 'server/discover') {
        return {
          protocolVersion: '2026-07-28',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          serverInfo: { name: 'demo', version: '1.0.0' },
        };
      }
      return { result: { echo: body.params } };
    },
  };
  const state = createMcpAppsV16State();
  const tools = createMcpAppsV16Tools(state, {
    transport,
    defaultEndpoints: ['https://a.example/rpc'],
    hmacSecret: 'test-secret-at-least-16-chars',
  });

  const created = await runTool(tools, 'mcp_apps_v16_elicit_url_create', {
    purpose: 'oauth-signin',
    url: 'https://accounts.google.com/o/oauth2/auth',
    serverName: 'demo',
    prompt: 'Đăng nhập Google.',
  });
  assert.equal(created.ok, true);
  assert.equal(created.session.status, 'pending');
  assert.ok(created.callbackToken.startsWith('v16url.'));
  const completed = await runTool(tools, 'mcp_apps_v16_elicit_url_complete', {
    callbackToken: created.callbackToken,
    reference: 'txn-9',
  });
  assert.equal(completed.session.status, 'completed');
  assert.equal(completed.session.reference, 'txn-9');

  const called = await runTool(tools, 'mcp_apps_v16_stateless_call', {
    method: 'tools/call',
    params: { name: 'demo' },
  });
  assert.equal(called.ok, true);
  assert.equal(called.endpointUrl, 'https://a.example/rpc');
  assert.equal(called.result.result.echo.name, 'demo');

  // MRTR qua tool: scripted server hỏi 1 input rồi complete.
  let scriptCalls = 0;
  const scriptedTools = createMcpAppsV16Tools(createMcpAppsV16State(), {
    hmacSecret: 'test-secret-at-least-16-chars',
    scriptedServer: async (method, params) => {
      scriptCalls += 1;
      if (scriptCalls === 1) {
        return {
          resultType: 'input_required',
          inputRequests: [{ id: 'city', prompt: 'Thành phố?', mode: 'form', schema: { type: 'string' } }],
        };
      }
      return { resultType: 'complete', data: { city: params.inputResponses[0].value } };
    },
  });
  const mrtr = await runTool(scriptedTools, 'mcp_apps_v16_mrtr_run', {
    method: 'tools/call',
    params: { name: 'weather' },
    answers: { city: 'Saigon' },
  });
  assert.equal(mrtr.outcome.completed, true);
  assert.deepEqual(mrtr.outcome.data, { city: 'Saigon' });
  assert.equal(scriptCalls, 2);

  // MRTR dry-run: chỉ dựng envelope, không gọi server.
  const dry = await runTool(scriptedTools, 'mcp_apps_v16_mrtr_run', {
    method: 'tools/call',
    params: { name: 'weather' },
    dryRunEnvelope: true,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.envelope.method, 'tools/call');
  assert.equal(dry.envelope.params._meta.protocolVersion, '2026-07-28');
});

test('tools v16: apps pipeline declare → prefetch → review → open qua tool', async () => {
  const state = createMcpAppsV16State();
  const tools = createMcpAppsV16Tools(state);
  const declared = await runTool(tools, 'mcp_apps_v16_apps_declare', {
    name: 'dashboard',
    version: '1.2.0',
    server: 'demo',
    resourceUri: 'ui://demo/dashboard',
    capabilities: [],
    sandboxProfile: 'display-only',
    cspProfile: 'strict',
  });
  assert.equal(declared.template.status, 'declared');
  const prefetched = await runTool(tools, 'mcp_apps_v16_apps_prefetch', {
    name: 'dashboard',
    html: HTML,
  });
  assert.equal(prefetched.template.status, 'prefetched');
  const reviewed = await runTool(tools, 'mcp_apps_v16_apps_review', {
    name: 'dashboard',
    decision: 'approved',
    reviewer: 'ada',
    note: 'ok',
  });
  assert.equal(reviewed.template.status, 'ready');
  // Mở khi extension tắt → lỗi.
  await assert.rejects(
    () =>
      runTool(tools, 'mcp_apps_v16_apps_open', {
        name: 'dashboard',
        html: HTML,
        clientExtensions: [],
        serverExtensions: ['io.modelcontextprotocol/ui'],
      }),
    /chưa được thương lượng bật/,
  );
  const opened = await runTool(tools, 'mcp_apps_v16_apps_open', {
    name: 'dashboard',
    html: HTML,
    clientExtensions: ['io.modelcontextprotocol/ui'],
    serverExtensions: ['io.modelcontextprotocol/ui'],
    displayMode: 'inline',
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.session.appName, 'dashboard');
  assert.equal(opened.session.displayMode, 'inline');
  assert.equal(opened.displayModeNegotiated.mode, 'inline');
});

test('i18n: 24 key mcpApps.v16.* có đủ 6 locale, giá trị không rỗng, tổng key >= 7381', () => {
  for (const locale of LOCALE_NAMES) {
    const data = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8'));
    for (const key of MCP_APPS_V16_KEYS) {
      assert.ok(
        typeof data[key] === 'string' && data[key].length > 0,
        `${locale} thiếu key ${key}`,
      );
    }
    assert.ok(
      Object.keys(data).length >= 7357 + MCP_APPS_V16_KEYS.length,
      `${locale} tổng key ${Object.keys(data).length}, mong đợi >= ${7357 + MCP_APPS_V16_KEYS.length}`,
    );
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${locale} keys phải giữ thứ tự sắp xếp`);
  }
});
