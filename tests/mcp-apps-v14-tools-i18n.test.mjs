/**
 * Test v1.34 T3: MCP Apps v14 tools + i18n (node:test).
 * Local only, no network.
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-apps-v14-tools-i18n.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMcpAppsV14Tools,
  MCP_APPS_V14_TOOL_NAMES,
  MCP_APPS_V14_TOOLS,
} from '../packages/tools/dist/mcpAppsV14Tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const MCP_APPS_V14_KEYS = [
  'mcpApps.v14.auditTitle',
  'mcpApps.v14.blocked',
  'mcpApps.v14.closeApp',
  'mcpApps.v14.consentApprove',
  'mcpApps.v14.consentDeny',
  'mcpApps.v14.consentPending',
  'mcpApps.v14.consentRequest',
  'mcpApps.v14.consentTitle',
  'mcpApps.v14.noFallback',
  'mcpApps.v14.notRegistered',
  'mcpApps.v14.openApp',
  'mcpApps.v14.originBlocked',
  'mcpApps.v14.previewTitle',
  'mcpApps.v14.sandboxNote',
  'mcpApps.v14.textFallbackLabel',
  'mcpApps.v14.textOnlyMode',
  'mcpApps.v14.title',
  'mcpApps.v14.uiMode',
];

const SAFE_HTML =
  '<!doctype html><html><head><style>body{color:navy}</style></head><body><h1>Hi</h1></body></html>';
const FALLBACK_TEXT =
  'Dashboard: 3 task đang chạy, 2 app đang mở, 128 lần gọi tool hôm nay. Đây là bản text đầy đủ cho client không render được.';

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tool, args) {
  const raw = await tool.execute(args);
  assert.equal(typeof raw, 'string');
  return JSON.parse(raw);
}

test('v14 tools: 8 tool, tên + needsApproval đúng', () => {
  assert.deepEqual([...MCP_APPS_V14_TOOL_NAMES], [
    'mcp_apps_v14_register',
    'mcp_apps_v14_declare_tool_ui',
    'mcp_apps_v14_list_ui_tools',
    'mcp_apps_v14_negotiate',
    'mcp_apps_v14_open',
    'mcp_apps_v14_preview',
    'mcp_apps_v14_consent',
    'mcp_apps_v14_audit',
  ]);
  assert.equal(MCP_APPS_V14_TOOLS.length, 8);
  for (const name of MCP_APPS_V14_TOOL_NAMES) {
    const tool = toolByName(MCP_APPS_V14_TOOLS, name);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 20, name);
  }
  // Chỉ mở app và quyết định consent cần approval; đọc thì không.
  assert.equal(toolByName(MCP_APPS_V14_TOOLS, 'mcp_apps_v14_open').needsApproval, true);
  assert.equal(toolByName(MCP_APPS_V14_TOOLS, 'mcp_apps_v14_consent').needsApproval, true);
  assert.equal(toolByName(MCP_APPS_V14_TOOLS, 'mcp_apps_v14_register').needsApproval, false);
  assert.equal(toolByName(MCP_APPS_V14_TOOLS, 'mcp_apps_v14_negotiate').needsApproval, false);
  assert.equal(toolByName(MCP_APPS_V14_TOOLS, 'mcp_apps_v14_audit').needsApproval, false);
});

test('v14 tools: luồng register → declare → negotiate → open → preview → audit', async () => {
  const tools = createMcpAppsV14Tools();
  const register = toolByName(tools, 'mcp_apps_v14_register');
  const declare = toolByName(tools, 'mcp_apps_v14_declare_tool_ui');
  const list = toolByName(tools, 'mcp_apps_v14_list_ui_tools');
  const negotiate = toolByName(tools, 'mcp_apps_v14_negotiate');
  const open = toolByName(tools, 'mcp_apps_v14_open');
  const preview = toolByName(tools, 'mcp_apps_v14_preview');
  const consent = toolByName(tools, 'mcp_apps_v14_consent');
  const audit = toolByName(tools, 'mcp_apps_v14_audit');

  // Khai báo trước khi đăng ký resource → lỗi (không crash).
  await assert.rejects(
    () =>
      declare.execute({
        toolName: 'show-dashboard',
        resourceUri: 'ui://my-server/dashboard',
        textFallback: FALLBACK_TEXT,
      }),
    /chưa đăng ký/,
  );

  const reg = await run(register, {
    uri: 'ui://my-server/dashboard',
    html: SAFE_HTML,
    title: 'Dashboard',
    toolName: 'show-dashboard',
    mimeType: 'text/html;profile=mcp-app',
  });
  assert.equal(reg.ok, true);
  assert.equal(reg.uri, 'ui://my-server/dashboard');
  assert.equal(reg.version, '14.0.0');

  const dec = await run(declare, {
    toolName: 'show-dashboard',
    resourceUri: 'ui://my-server/dashboard',
    textFallback: FALLBACK_TEXT,
    displayMode: 'inline',
  });
  assert.equal(dec.ok, true);
  assert.equal(dec.resourceUri, 'ui://my-server/dashboard');
  assert.ok(dec.fallbackChars >= 20);

  const listed = await run(list, {});
  assert.equal(listed.ok, true);
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0].toolName, 'show-dashboard');
  assert.equal(listed.tools[0].resourceRegistered, true);

  const term = await run(negotiate, { toolName: 'show-dashboard', clientSupportsApps: false });
  assert.equal(term.sendUi, false);
  assert.equal(term.reasonCode, 'client-no-apps');
  const gui = await run(negotiate, {
    toolName: 'show-dashboard',
    clientSupportsApps: true,
    renderModes: ['inline'],
  });
  assert.equal(gui.sendUi, true);
  assert.equal(gui.renderMode, 'inline');

  // Client terminal → text fallback đầy đủ.
  const textOpened = await run(open, { uri: 'ui://my-server/dashboard', clientSupportsApps: false });
  assert.equal(textOpened.mode, 'text');
  assert.equal(textOpened.textFallback, FALLBACK_TEXT);

  // Client GUI → UI sandbox + bridge session.
  const uiOpened = await run(open, {
    uri: 'ui://my-server/dashboard',
    clientSupportsApps: true,
    renderModes: ['inline'],
  });
  assert.equal(uiOpened.mode, 'ui');
  assert.equal(uiOpened.sandbox, 'allow-scripts');
  assert.ok(uiOpened.csp.includes("default-src 'none'"));
  assert.ok(uiOpened.bridgeSessionId.startsWith('ui-v14-'));
  assert.ok(uiOpened.srcdocChars > 100);

  const prev = await run(preview, { uri: 'ui://my-server/dashboard' });
  assert.equal(prev.ok, true);
  assert.equal(prev.declaredByTool, 'show-dashboard');
  assert.equal(prev.hasTextFallback, true);
  assert.ok(Array.isArray(prev.audit));
  assert.ok(Array.isArray(prev.consents));

  const consents = await run(consent, { action: 'list' });
  assert.equal(consents.ok, true);
  assert.deepEqual(consents.consents, []);
  const badConsent = await run(consent, { action: 'approve', consentId: 'no-such-id' });
  assert.equal(badConsent.ok, false);
  assert.match(badConsent.error, /no longer pending/);

  const auditLog = await run(audit, {});
  assert.equal(auditLog.ok, true);
  assert.ok(Array.isArray(auditLog.entries));
});

test('v14 tools: register từ chối HTML không phải document + declare thiếu fallback', async () => {
  const tools = createMcpAppsV14Tools();
  const register = toolByName(tools, 'mcp_apps_v14_register');
  await assert.rejects(
    () => register.execute({ uri: 'ui://s/app', html: '<p>đoạn lẻ</p>' }),
    /HTML document|document đầy đủ/,
  );
  await register.execute({ uri: 'ui://s/app', html: SAFE_HTML });
  const declare = toolByName(tools, 'mcp_apps_v14_declare_tool_ui');
  await assert.rejects(
    () => declare.execute({ toolName: 't', resourceUri: 'ui://s/app', textFallback: 'ngắn' }),
    /quá ngắn/,
  );
});

test('v14 i18n: 18 key mcpApps.v14.* có mặt + không rỗng ở cả 6 locale', () => {
  assert.equal(MCP_APPS_V14_KEYS.length, 18);
  for (const locale of LOCALE_NAMES) {
    const data = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8'));
    for (const key of MCP_APPS_V14_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale}:${key}`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key}`);
    }
  }
  // Sanity: bản dịch khác nhau giữa các locale (không phải copy y nguyên).
  const vi = JSON.parse(readFileSync(join(localesDir, 'vi.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'));
  assert.notEqual(vi['mcpApps.v14.title'], en['mcpApps.v14.title']);
  assert.notEqual(vi['mcpApps.v14.consentApprove'], en['mcpApps.v14.consentApprove']);
});
