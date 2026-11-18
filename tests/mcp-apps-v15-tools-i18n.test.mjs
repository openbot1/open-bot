/**
 * Test v1.35 T3: MCP Apps v15 tools + i18n (node:test).
 * Local only, no network.
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-apps-v15-tools-i18n.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMcpAppsV15Tools,
  MCP_APPS_V15_TOOL_NAMES,
  MCP_APPS_V15_TOOLS,
} from '../packages/tools/dist/mcpAppsV15Tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const MCP_APPS_V15_KEYS = [
  'mcpApps.v15.auditTitle',
  'mcpApps.v15.blocked',
  'mcpApps.v15.closeApp',
  'mcpApps.v15.consentApprove',
  'mcpApps.v15.consentDeny',
  'mcpApps.v15.consentPending',
  'mcpApps.v15.consentRequest',
  'mcpApps.v15.consentTitle',
  'mcpApps.v15.manifestTitle',
  'mcpApps.v15.noFallback',
  'mcpApps.v15.notRegistered',
  'mcpApps.v15.openApp',
  'mcpApps.v15.originBlocked',
  'mcpApps.v15.previewTitle',
  'mcpApps.v15.sandboxNote',
  'mcpApps.v15.skillCreateTitle',
  'mcpApps.v15.skillMigrateTitle',
  'mcpApps.v15.textFallbackLabel',
  'mcpApps.v15.textOnlyMode',
  'mcpApps.v15.title',
  'mcpApps.v15.uiMode',
  'mcpApps.v15.visualiserTitle',
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

test('v15 tools: 11 tool, tên + needsApproval đúng', () => {
  assert.deepEqual([...MCP_APPS_V15_TOOL_NAMES], [
    'mcp_apps_v15_register',
    'mcp_apps_v15_manifest',
    'mcp_apps_v15_declare_tool_ui',
    'mcp_apps_v15_open',
    'mcp_apps_v15_bridge_message',
    'mcp_apps_v15_consent',
    'mcp_apps_v15_visualise',
    'mcp_apps_v15_skill_create',
    'mcp_apps_v15_skill_add',
    'mcp_apps_v15_skill_migrate',
    'mcp_apps_v15_audit',
  ]);
  assert.equal(MCP_APPS_V15_TOOLS.length, 11);
  for (const name of MCP_APPS_V15_TOOL_NAMES) {
    const tool = toolByName(MCP_APPS_V15_TOOLS, name);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 20, name);
  }
  // Chỉ mở app và quyết định consent cần approval; đọc thì không.
  assert.equal(toolByName(MCP_APPS_V15_TOOLS, 'mcp_apps_v15_open').needsApproval, true);
  assert.equal(toolByName(MCP_APPS_V15_TOOLS, 'mcp_apps_v15_consent').needsApproval, true);
  assert.equal(toolByName(MCP_APPS_V15_TOOLS, 'mcp_apps_v15_register').needsApproval, false);
  assert.equal(toolByName(MCP_APPS_V15_TOOLS, 'mcp_apps_v15_manifest').needsApproval, false);
  assert.equal(toolByName(MCP_APPS_V15_TOOLS, 'mcp_apps_v15_visualise').needsApproval, false);
  assert.equal(toolByName(MCP_APPS_V15_TOOLS, 'mcp_apps_v15_audit').needsApproval, false);
  assert.equal(toolByName(MCP_APPS_V15_TOOLS, 'mcp_apps_v15_skill_create').needsApproval, false);
});

test('v15 tools: MIME trần bị từ chối ở register; manifest treo bị từ chối', async () => {
  const tools = createMcpAppsV15Tools();
  const register = toolByName(tools, 'mcp_apps_v15_register');
  const manifest = toolByName(tools, 'mcp_apps_v15_manifest');
  await assert.rejects(
    () => register.execute({ uri: 'ui://my-server/plain', html: SAFE_HTML, mimeType: 'text/html' }),
    /text\/html;profile=mcp-app/,
  );
  await assert.rejects(
    () =>
      manifest.execute({
        name: 'ghost',
        version: '1.0.0',
        server: 'my-server',
        resourceUri: 'ui://my-server/ghost',
      }),
    /chưa đăng ký/,
  );
});

test('v15 tools: luồng register → manifest → declare → open → bridge → consent → audit', async () => {
  const tools = createMcpAppsV15Tools();
  const register = toolByName(tools, 'mcp_apps_v15_register');
  const manifest = toolByName(tools, 'mcp_apps_v15_manifest');
  const declare = toolByName(tools, 'mcp_apps_v15_declare_tool_ui');
  const open = toolByName(tools, 'mcp_apps_v15_open');
  const bridge = toolByName(tools, 'mcp_apps_v15_bridge_message');
  const consent = toolByName(tools, 'mcp_apps_v15_consent');
  const audit = toolByName(tools, 'mcp_apps_v15_audit');

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
  });
  assert.equal(reg.ok, true);
  assert.equal(reg.uri, 'ui://my-server/dashboard');
  assert.equal(reg.version, '15.0.0');
  assert.equal(reg.mimeType, 'text/html;profile=mcp-app');

  const man = await run(manifest, {
    name: 'dashboard',
    version: '1.2.0',
    server: 'my-server',
    resourceUri: 'ui://my-server/dashboard',
    capabilities: ['tools-call'],
    sandboxProfile: 'interactive',
  });
  assert.equal(man.ok, true);
  assert.equal(man.manifest.name, 'dashboard');
  assert.equal(man.manifest.sandboxProfile, 'interactive');

  const dec = await run(declare, {
    toolName: 'show-dashboard',
    resourceUri: 'ui://my-server/dashboard',
    textFallback: FALLBACK_TEXT,
  });
  assert.equal(dec.ok, true);
  assert.equal(dec.hasManifest, true);
  assert.equal(dec.fallbackChars, FALLBACK_TEXT.length);

  const opened = await run(open, {
    toolName: 'show-dashboard',
    toolResult: { content: [{ type: 'text', text: FALLBACK_TEXT }] },
    clientSupportsApps: true,
    renderModes: ['inline'],
    locale: 'vi',
    timezone: 'Asia/Ho_Chi_Minh',
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.mode, 'ui');
  assert.equal(opened.appUri, 'ui://my-server/dashboard');
  assert.ok(opened.bridgeSessionId.startsWith('v15-'));
  assert.equal(opened.hostContext.locale, 'vi');
  assert.equal(opened.hostContext.consentRequired, true);
  const sessionId = opened.bridgeSessionId;

  // Client text-only → text fallback.
  const textMode = await run(open, {
    toolName: 'show-dashboard',
    toolResult: { content: [{ type: 'text', text: FALLBACK_TEXT }] },
    clientSupportsApps: false,
  });
  assert.equal(textMode.mode, 'text');
  assert.ok(textMode.textFallback.includes('Dashboard'));

  // Bridge: initialize rồi gọi tool chính (read-only, chưa auto-approve → consent).
  const init = await run(bridge, {
    sessionId,
    message: { jsonrpc: '2.0', method: 'ui/initialize', params: { clientInfo: { name: 'dashboard' } }, id: 1 },
    origin: 'null',
  });
  assert.equal(init.response.error, undefined);
  assert.equal(init.response.result.protocolVersion, 'ui/1.0');
  const call = await run(bridge, {
    sessionId,
    message: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'show-dashboard', arguments: {} }, id: 2 },
    origin: 'null',
  });
  assert.equal(call.response.error.code, -32010);

  // Consent: liệt kê → duyệt → host không có handler tools/call nên trả -32603 (fail-closed).
  const listed = await run(consent, { action: 'list' });
  assert.equal(listed.total, 1);
  assert.equal(listed.pending[0].toolName, 'show-dashboard');
  const decided = await run(consent, { action: 'approve', consentId: listed.pending[0].id });
  assert.equal(decided.ok, true);
  assert.equal(decided.decision, 'approved');
  assert.equal(decided.bridgeResponse.error.code, -32603);
  const listedAfter = await run(consent, { action: 'list' });
  assert.equal(listedAfter.total, 0);

  // Audit: chain còn nguyên vẹn.
  const auditResult = await run(audit, { limit: 50 });
  assert.equal(auditResult.ok, true);
  assert.equal(auditResult.chainValid, true);
  assert.equal(auditResult.consentChainValid, true);
  assert.ok(auditResult.entries.length >= 1);
  assert.equal(auditResult.stats.openApps, 1);
});

test('v15 tools: visualise — pie chart + text fallback; skill create/add/migrate', async () => {
  const tools = createMcpAppsV15Tools();
  const visualise = toolByName(tools, 'mcp_apps_v15_visualise');
  const skillCreate = toolByName(tools, 'mcp_apps_v15_skill_create');
  const skillAdd = toolByName(tools, 'mcp_apps_v15_skill_add');
  const skillMigrate = toolByName(tools, 'mcp_apps_v15_skill_migrate');

  const vis = await run(visualise, {
    data: [
      { label: 'A', value: 30 },
      { label: 'B', value: 70 },
    ],
    title: 'Tỉ lệ',
  });
  assert.equal(vis.kind, 'pie-chart');
  assert.ok(vis.html.includes('<svg'));
  assert.ok(vis.textFallback.includes('70.0%'));
  const none = await run(visualise, { data: 'chuỗi', title: 'Chuỗi' });
  assert.equal(none.kind, 'none');

  const skill = await run(skillCreate, {
    name: 'sales-apps',
    description: 'Skill tạo app dashboard bán hàng cho đội kinh doanh theo dõi doanh số mỗi ngày.',
    defaultTemplate: 'dashboard',
    defaultServer: 'local-apps',
  });
  assert.equal(skill.ok, true);
  assert.equal(skill.manifest.name, 'sales-apps');
  assert.ok(skill.files.some((f) => f.path === 'SKILL.md'));

  const added = await run(skillAdd, {
    skillName: 'sales-apps',
    appName: 'sales-form',
    serverName: 'local-apps',
    template: 'form',
  });
  assert.equal(added.ok, true);
  assert.deepEqual(added.manifest.apps, ['sales-apps', 'sales-form']);
  await assert.rejects(
    () => skillAdd.execute({ skillName: 'sales-apps', appName: 'sales-form', serverName: 'local-apps' }),
    /đã có app/,
  );
  await assert.rejects(
    () => skillAdd.execute({ skillName: 'missing-skill', appName: 'x', serverName: 'local-apps' }),
    /not registered/,
  );

  const migrated = await run(skillMigrate, {
    html: SAFE_HTML,
    resourceUri: 'ui://my-server/old-app',
    serverName: 'my-server',
    fromVersion: '14',
  });
  assert.equal(migrated.ok, true);
  assert.ok(migrated.html.includes('McpAppBridge'));
  assert.equal(migrated.manifest.name, 'old-app');
  assert.ok(migrated.changes.length >= 2);
});

test('v15 i18n: đủ key mcpApps.v15.* ở cả 6 locale, không rỗng, không trùng vi', () => {
  for (const locale of LOCALE_NAMES) {
    const data = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8'));
    for (const key of MCP_APPS_V15_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale} thiếu key ${key}`);
      assert.ok(data[key].trim().length > 0, `${locale} key ${key} rỗng`);
    }
  }
  // Khác biệt locale: bản vi khác bản en ở key title/consent.
  const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'));
  const vi = JSON.parse(readFileSync(join(localesDir, 'vi.json'), 'utf8'));
  assert.notEqual(en['mcpApps.v15.consentApprove'], vi['mcpApps.v15.consentApprove']);
  assert.notEqual(en['mcpApps.v15.visualiserTitle'], vi['mcpApps.v15.visualiserTitle']);
  // Placeholder {count}/{tool}/{message} giữ nguyên qua locale.
  for (const locale of LOCALE_NAMES) {
    const data = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8'));
    assert.ok(data['mcpApps.v15.consentPending'].includes('{count}'), locale);
    assert.ok(data['mcpApps.v15.consentRequest'].includes('{tool}'), locale);
    assert.ok(data['mcpApps.v15.blocked'].includes('{message}'), locale);
  }
});
