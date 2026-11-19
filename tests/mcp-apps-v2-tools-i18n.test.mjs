/**
 * Test v1.14 T2: MCP Apps v2 tools + i18n (node:test).
 * Local only, no network.
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-apps-v2-tools-i18n.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMcpAppsV2Tools,
  MCP_APPS_V2_TOOL_NAMES,
  MCP_APPS_V2_TOOLS,
} from '../packages/tools/dist/mcpAppsV2Tools.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const MCP_APPS_V2_KEYS = [
  'mcpAppsV2.title',
  'mcpAppsV2.negotiationTitle',
  'mcpAppsV2.appsEnabled',
  'mcpAppsV2.appsDisabled',
  'mcpAppsV2.tasksEnabled',
  'mcpAppsV2.tasksDisabled',
  'mcpAppsV2.fallbackText',
  'mcpAppsV2.galleryTitle',
  'mcpAppsV2.templateDashboard',
  'mcpAppsV2.templateForm',
  'mcpAppsV2.templateChart',
  'mcpAppsV2.templateWizard',
  'mcpAppsV2.renderTemplate',
  'mcpAppsV2.bundleTitle',
  'mcpAppsV2.bundleWarnings',
  'mcpAppsV2.permissionsTitle',
  'mcpAppsV2.permissionGranted',
  'mcpAppsV2.permissionDenied',
  'mcpAppsV2.permissionPrompt',
  'mcpAppsV2.permissionRevoke',
  'mcpAppsV2.permissionRemember',
  'mcpAppsV2.polling',
  'mcpAppsV2.taskCompleted',
  'mcpAppsV2.taskFailed',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function findTool(name) {
  const tool = MCP_APPS_V2_TOOLS.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test('tools v2: 8 tools with the expected names, wired into the full registry', () => {
  assert.equal(MCP_APPS_V2_TOOLS.length, 8);
  assert.deepEqual([...MCP_APPS_V2_TOOL_NAMES], [
    'mcp_apps_v2_negotiate',
    'mcp_apps_v2_gallery_list',
    'mcp_apps_v2_gallery_render',
    'mcp_apps_v2_bundle',
    'mcp_apps_v2_permissions_get',
    'mcp_apps_v2_permissions_set',
    'mcp_apps_v2_permissions_revoke',
    'mcp_apps_v2_components_render',
  ]);
  // Registry đầy đủ qua defaultToolFactory (như các pin test khác):
  // 820 (v1.13) + 8 = 828.
  const ws = mkdtempSync(join(tmpdir(), 'open-bot-mcpappsv2-ws-'));
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'BOT_A');
    const allNames = tools.map((t) => t.definition.name);
    for (const name of MCP_APPS_V2_TOOL_NAMES) {
      assert.ok(allNames.includes(name), `registry missing ${name}`);
    }
    assert.ok(allNames.length >= 1453, `expected >= 1453 tools, got ${allNames.length}`); // v1.39 fix round 4b: floor (was 1453; now 1539).
    assert.equal(new Set(allNames).size, allNames.length, 'duplicate tool names');
  } finally {
    mem.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('tools v2: negotiate returns two-way negotiation', async () => {
  const tool = findTool('mcp_apps_v2_negotiate');
  const out = JSON.parse(
    await tool.execute({
      serverName: 'demo',
      discover: {
        protocolVersion: '2026-07-28',
        capabilities: {
          apps: { uiResources: true, templates: true, bridgeToolCalls: true },
          tasks: { specVersion: '2026-07-28', update: true },
        },
        extensions: ['io.modelcontextprotocol/ui', 'io.modelcontextprotocol/tasks'],
      },
    }),
  );
  assert.equal(out.apps.enabled, true);
  assert.equal(out.apps.level, 'full');
  assert.equal(out.tasks.enabled, true);
  const plain = JSON.parse(
    await tool.execute({ serverName: 'plain', discover: { capabilities: {} } }),
  );
  assert.equal(plain.apps.enabled, false);
  assert.ok(plain.notes.length > 0);
});

test('tools v2: gallery list + render', async () => {
  const list = findTool('mcp_apps_v2_gallery_list');
  const listed = JSON.parse(await list.execute({}));
  assert.equal(listed.total, 4);
  const chartOnly = JSON.parse(await list.execute({ kind: 'chart' }));
  assert.equal(chartOnly.total, 1);
  const render = findTool('mcp_apps_v2_gallery_render');
  const rendered = JSON.parse(
    await render.execute({
      templateId: 'form',
      input: {
        title: 'T',
        tool: 'demo_tool',
        fields: [{ name: 'a', label: 'A', type: 'text' }],
      },
    }),
  );
  assert.equal(rendered.kind, 'form');
  assert.ok(rendered.html.includes('<form') || rendered.html.includes('form'));
  await assert.rejects(() => render.execute({ templateId: 'nope', input: {} }), /không có template/);
});

test('tools v2: bundle strips externals and returns CSP', async () => {
  const tool = findTool('mcp_apps_v2_bundle');
  const out = JSON.parse(
    await tool.execute({
      html: '<html><head></head><body><script src="https://x.example.com/a.js"></script><p>hi</p></body></html>',
      css: ['p{color:blue}'],
      network: true,
      allowedConnectHosts: ['api.example.com'],
    }),
  );
  assert.ok(!out.html.includes('x.example.com'));
  assert.ok(out.html.includes('p{color:blue}'));
  assert.match(out.csp, /connect-src https:\/\/api\.example\.com/);
  assert.ok(out.warnings.length >= 1);
});

test('tools v2: permissions get/set/revoke round-trip', async () => {
  const tools = createMcpAppsV2Tools();
  const byName = (n) => tools.find((t) => t.definition.name === n);
  const appUri = 'ui://demo-server/dashboard';
  const get = byName('mcp_apps_v2_permissions_get');
  const set = byName('mcp_apps_v2_permissions_set');
  const revoke = byName('mcp_apps_v2_permissions_revoke');
  assert.equal(set.needsApproval, true);
  assert.equal(revoke.needsApproval, true);
  let state = JSON.parse(await get.execute({ appUri }));
  assert.equal(state.decisions.microphone, 'prompt');
  await set.execute({ appUri, permission: 'microphone', decision: 'granted', remember: true });
  state = JSON.parse(await get.execute({ appUri }));
  assert.equal(state.decisions.microphone, 'granted');
  const revoked = JSON.parse(await revoke.execute({ appUri, permission: 'microphone' }));
  assert.equal(revoked.revoked, 1);
  state = JSON.parse(await get.execute({ appUri }));
  assert.equal(state.decisions.microphone, 'prompt');
  await assert.rejects(
    () => set.execute({ appUri, permission: 'geolocation', decision: 'granted' }),
    /microphone| camera/,
  );
});

test('tools v2: components render validates + escapes', async () => {
  const tool = findTool('mcp_apps_v2_components_render');
  const out = JSON.parse(
    await tool.execute({
      components: [
        { type: 'button', label: 'OK', action: { label: 'OK', tool: 'demo_tool' } },
        { type: 'progressBar', label: 'Tiến độ', value: 1, max: 2, showPercent: true },
        { type: 'toast', message: '<b>hi</b>' },
      ],
    }),
  );
  assert.equal(out.count, 3);
  assert.ok(out.html.includes('.ob-btn'));
  assert.ok(!out.html.includes('<b>hi</b>'));
  await assert.rejects(
    () => tool.execute({ components: [{ type: 'button' }] }),
    /Invalid v2 components/,
  );
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test('i18n v2: all 6 locales have the 24 mcpAppsV2 keys (4983 -> 5278 total)', () => {
  for (const name of LOCALE_NAMES) {
    const locale = loadLocale(name);
    assert.ok(Object.keys(locale).length >= 8072, `${name}: expected >= 8072 keys, got ${Object.keys(locale).length}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
    for (const key of MCP_APPS_V2_KEYS) {
      assert.equal(typeof locale[key], 'string', `${name}: missing ${key}`);
      assert.ok(locale[key].length > 0, `${name}: empty ${key}`);
    }
  }
  const vi = loadLocale('vi');
  for (const key of MCP_APPS_V2_KEYS) {
    const viPlaceholders = placeholders(vi[key]);
    for (const name of LOCALE_NAMES) {
      const locale = loadLocale(name);
      assert.deepEqual(
        placeholders(locale[key]),
        viPlaceholders,
        `${name}:${key} placeholder mismatch`,
      );
    }
  }
});
