/**
 * Test v1.13 T2: MCP Apps host v13 — component kit + host orchestrator + tools (node:test).
 * Local only, no network.
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-apps-v113-components-host.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppClientShim,
  countAppComponents,
  escapeAppComponentText,
  renderAppComponent,
  renderAppComponents,
  validateAppComponent,
} from '../packages/core/dist/mcp/appsComponents.js';
import { validateAppHtml } from '../packages/core/dist/mcp/apps.js';
import {
  buildSampleAppComponents,
  McpAppHostV13,
  sampleAppMeta,
} from '../packages/core/dist/mcp/appsHostV13.js';
import { parseToolUiMeta } from '../packages/core/dist/mcp/appsUiMeta.js';
import {
  createMcpAppsV113Tools,
  MCP_APPS_V113_TOOL_NAMES,
  MCP_APPS_V113_TOOLS,
} from '../packages/tools/dist/mcpAppsV113Tools.js';

const SAFE_TOOL_HTML =
  '<!doctype html><html><head><style>body{color:navy}</style></head><body><h1>Dashboard</h1></body></html>';

// ---------------------------------------------------------------------------
// Component kit
// ---------------------------------------------------------------------------

test('components: escape + validate each component type', () => {
  assert.equal(escapeAppComponentText('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  assert.deepEqual(validateAppComponent({ type: 'card', title: 'Hello' }), []);
  assert.deepEqual(validateAppComponent({ type: 'metric', label: 'Users', value: 128, trend: 'up' }), []);
  assert.deepEqual(
    validateAppComponent({
      type: 'table',
      columns: ['A', 'B'],
      rows: [['1', 2]],
    }),
    [],
  );
  assert.deepEqual(
    validateAppComponent({
      type: 'form',
      tool: 'echo',
      fields: [{ name: 'q', label: 'Q', type: 'select', options: ['a', 'b'] }],
    }),
    [],
  );
  assert.deepEqual(
    validateAppComponent({ type: 'list', items: [{ title: 'One' }, { title: 'Two', badge: 'new' }] }),
    [],
  );
  assert.deepEqual(
    validateAppComponent({ type: 'chart-placeholder', kind: 'bar', labels: ['A'], values: [3] }),
    [],
  );
  assert.deepEqual(
    validateAppComponent({ type: 'stack', children: [{ type: 'card', title: 'x' }] }),
    [],
  );
  assert.deepEqual(
    validateAppComponent({ type: 'grid', columns: 2, children: [{ type: 'card', title: 'x' }] }),
    [],
  );
  assert.deepEqual(validateAppComponent({ type: 'html', html: '<p>raw</p>' }), []);
});

test('components: validation rejects bad shapes with clear errors', () => {
  assert.ok(validateAppComponent({ type: 'nope' }).some((e) => e.includes('không rõ')));
  assert.ok(validateAppComponent({ type: 'card' }).some((e) => e.includes('title')));
  assert.ok(validateAppComponent({ type: 'metric', label: 'x' }).some((e) => e.includes('value')));
  assert.ok(
    validateAppComponent({ type: 'metric', label: 'x', value: 1, trend: 'sideways' }).some((e) => e.includes('trend')),
  );
  assert.ok(
    validateAppComponent({ type: 'table', columns: ['A'], rows: [['1', '2']] }).some((e) => e.includes('số ô')),
  );
  assert.ok(
    validateAppComponent({ type: 'table', columns: ['A'], rows: Array.from({ length: 51 }, () => ['x']) }).some((e) =>
      e.includes('50'),
    ),
  );
  assert.ok(
    validateAppComponent({
      type: 'form',
      tool: 'echo',
      fields: [
        { name: 'q', label: 'Q', type: 'text' },
        { name: 'q', label: 'Q2', type: 'text' },
      ],
    }).some((e) => e.includes('trùng name')),
  );
  assert.ok(
    validateAppComponent({ type: 'chart-placeholder', kind: 'bar', labels: ['A', 'B'], values: [1] }).some((e) =>
      e.includes('cùng độ dài'),
    ),
  );
  assert.ok(
    validateAppComponent({ type: 'html', html: '<script src="https://evil.example/x.js"></script>' }).some((e) =>
      e.includes('bị chặn'),
    ),
  );
  // Nesting too deep.
  let deep = { type: 'card', title: 'leaf' };
  for (let i = 0; i < 5; i++) deep = { type: 'stack', children: [deep] };
  assert.ok(validateAppComponent(deep).some((e) => e.includes('quá sâu')));
  assert.ok(validateAppComponent(null).some((e) => e.includes('object')));
  assert.equal(countAppComponents({ type: 'grid', columns: 2, children: [{ type: 'card', title: 'a' }, { type: 'card', title: 'b' }] }), 3);
});

test('components: render escapes text, renders table/metric/form/chart SVG', () => {
  const card = renderAppComponent({
    type: 'card',
    title: '<script>alert(1)</script>',
    description: 'A & B',
    badge: 'new',
    actions: [{ label: 'Run', tool: 'echo-tool', arguments: { q: 1 } }],
  });
  assert.ok(card.includes('&lt;script&gt;'));
  assert.ok(!card.includes('<script>alert(1)</script>'));
  assert.ok(card.includes('data-ob-action-tool="echo-tool"'));
  const metric = renderAppComponent({ type: 'metric', label: 'Users', value: 128, unit: 'người', delta: '+12%', trend: 'up' });
  assert.ok(metric.includes('128'));
  assert.ok(metric.includes('ob-delta-up'));
  const table = renderAppComponent({ type: 'table', columns: ['Name', 'N'], rows: [['a', 1]] });
  assert.ok(table.includes('<th>Name</th>') && table.includes('<td>1</td>'));
  const form = renderAppComponent({
    type: 'form',
    tool: 'echo',
    fields: [
      { name: 'q', label: 'Q', type: 'text', required: true },
      { name: 'n', label: 'N', type: 'number' },
      { name: 'c', label: 'C', type: 'select', options: ['a', 'b'] },
    ],
  });
  assert.ok(form.includes('data-ob-tool="echo"'));
  assert.ok(form.includes('type="submit"'));
  assert.ok(!form.includes('action='));
  const chart = renderAppComponent({ type: 'chart-placeholder', kind: 'line', labels: ['A', 'B'], values: [1, 2] });
  assert.ok(chart.includes('<svg'));
  assert.ok(chart.includes('<polyline'));
  const bar = renderAppComponent({ type: 'chart-placeholder', kind: 'bar', labels: ['A'], values: [5] });
  assert.ok(bar.includes('<rect'));
});

test('components: full document renders + passes validateAppHtml (shim included)', () => {
  const html = renderAppComponents(
    [
      { type: 'metric', label: 'Users', value: 128, trend: 'up' },
      {
        type: 'form',
        title: 'Feedback',
        tool: 'echo',
        fields: [{ name: 'msg', label: 'Message', type: 'textarea' }],
      },
      { type: 'chart-placeholder', kind: 'bar', labels: ['A', 'B'], values: [3, 7] },
    ],
    { title: 'Sample', theme: 'dark' },
  );
  assert.ok(html.includes('data-theme="dark"'));
  assert.ok(html.includes('window.__openbot'));
  const validation = validateAppHtml(html);
  assert.equal(validation.valid, true, JSON.stringify(validation.findings));
  const shim = buildAppClientShim();
  assert.ok(shim.includes('ui/initialize'));
  assert.ok(shim.includes('tools/call'));
  assert.ok(shim.includes('ui/open-link'));
  assert.ok(!shim.includes("'*'"));
  assert.ok(!shim.includes('window.parent'));
  assert.ok(!shim.includes('localStorage'));
  assert.ok(!shim.includes('eval('));
  assert.throws(() => renderAppComponents([]), /ít nhất một component/);
  assert.throws(() => renderAppComponents([{ type: 'nope' }]), /không rõ/);
});

// ---------------------------------------------------------------------------
// Host orchestrator
// ---------------------------------------------------------------------------

const TOOL_WITH_UI = {
  name: 'show-dashboard',
  _meta: { ui: { resourceUri: 'ui://my-server/dashboard', displayMode: 'inline', title: 'Dashboard' } },
};

test('host: openAppFromTool finds the declared resource in the tool result', () => {
  const host = new McpAppHostV13();
  const result = {
    content: [
      { type: 'text', text: 'here is your dashboard' },
      {
        type: 'resource',
        resource: { uri: 'ui://my-server/dashboard', mimeType: 'text/html;profile=mcp-app', text: SAFE_TOOL_HTML },
      },
    ],
  };
  const opened = host.openAppFromTool(TOOL_WITH_UI, result);
  assert.equal(opened.uri, 'ui://my-server/dashboard');
  assert.equal(opened.title, 'Dashboard');
  assert.equal(opened.displayMode, 'inline');
  assert.equal(opened.frameConfig.sandbox, 'allow-scripts');
  assert.match(opened.frameConfig.csp, /default-src 'none'/);
  assert.ok(opened.frameConfig.srcdoc.includes('Dashboard'));
  assert.equal(opened.hostContext.locale, 'en');
  assert.equal(host.manager.size, 1);
  assert.equal(host.registry.size, 1);
  assert.equal(host.dialect.size, 1);
  assert.equal(host.listApps().length, 1);
  assert.equal(host.listApps()[0].dialectInitialized, false);
  assert.equal(host.closeApp(opened.appId), true);
  assert.equal(host.manager.size, 0);
  assert.equal(host.dialect.size, 0);
});

test('host: openAppFromTool falls back to registry, then generic parseAppResult', () => {
  const host = new McpAppHostV13();
  // Registry fallback: register first, result carries no resource.
  host.registry.register({ uri: 'ui://srv/reg-app', html: SAFE_TOOL_HTML, toolName: 'reg-tool' });
  const tool = { name: 'reg-tool', _meta: { ui: { resourceUri: 'ui://srv/reg-app' } } };
  const opened = host.openAppFromTool(tool, { content: [{ type: 'text', text: 'no app here' }] });
  assert.equal(opened.uri, 'ui://srv/reg-app');
  // Generic fallback: no _meta.ui, structuredContent app.
  const opened2 = host.openAppFromTool(
    { name: 'other-tool' },
    { content: [], structuredContent: { app: { html: SAFE_TOOL_HTML, title: 'Generic' } } },
  );
  assert.equal(opened2.title, 'Generic');
  // No app anywhere -> error.
  assert.throws(
    () => host.openAppFromTool({ name: 'empty-tool' }, { content: [{ type: 'text', text: 'nothing' }] }),
    /không chứa MCP App/,
  );
  // Declared but missing -> error naming the URI.
  assert.throws(
    () => host.openAppFromTool(TOOL_WITH_UI, { content: [{ type: 'text', text: 'x' }] }),
    /ui:\/\/my-server\/dashboard/,
  );
});

test('host: openAppFromTool blocks invalid HTML and wrong MIME via registry', () => {
  const host = new McpAppHostV13();
  assert.throws(
    () =>
      host.openAppFromTool(
        { name: 'bad-tool' },
        { content: [], structuredContent: { app: { html: '<script src="https://evil.example/x.js"></script>' } } },
      ),
    /App bị chặn/,
  );
  assert.throws(
    () => host.registry.register({ uri: 'ui://srv/x', html: SAFE_TOOL_HTML, mimeType: 'text/csv' }),
    /MIME/,
  );
  assert.equal(parseToolUiMeta(TOOL_WITH_UI)?.resourceUri, 'ui://my-server/dashboard');
});

test('host: display modes, model context, task link, stats', async () => {
  const host = new McpAppHostV13();
  const opened = host.openSampleApp('monitor');
  assert.equal(opened.displayMode, 'pip');
  assert.equal(host.stats().pipAppIds.length, 1);
  const state = host.setDisplayMode(opened.appId, 'fullscreen');
  assert.equal(state.mode, 'fullscreen');
  assert.equal(host.stats().fullscreenAppId, opened.appId);
  assert.equal(host.exitOverlay(opened.appId).mode, 'pip');
  host.linkTask(opened.appId, 'task-123');
  assert.equal(host.linkedTask(opened.appId), 'task-123');
  const note = host.pushTaskProgress(opened.appId, { status: 'working', progress: 55, message: 'halfway' });
  assert.equal(note?.method, 'ui/model-context-updated');
  assert.equal(note?.params?.context?.taskStatus, 'working');
  assert.equal(note?.params?.context?.taskId, 'task-123');
  const ctx = host.updateModelContext(opened.appId, { data: { rows: 1 } });
  assert.equal(ctx?.method, 'ui/model-context-updated');
  assert.equal(host.updateModelContext('missing-app', {}), null);
  assert.throws(() => host.linkTask('missing-app', 't'), /Không có app/);
  assert.equal(host.stats().appsOpen, 1);
  host.updateHostContext({ locale: 'vi', theme: 'dark' });
  assert.equal(host.getHostContext().locale, 'vi');
  host.closeApp(opened.appId);
  assert.equal(host.stats().appsOpen, 0);
});

test('host: sample apps — all four kinds render valid HTML', () => {
  const host = new McpAppHostV13();
  for (const kind of ['dashboard', 'form', 'monitor', 'table']) {
    const components = buildSampleAppComponents(kind);
    assert.ok(components.length > 0, kind);
    const html = renderAppComponents(components, { title: sampleAppMeta(kind).title });
    assert.equal(validateAppHtml(html).valid, true, kind);
    const opened = host.openSampleApp(kind);
    assert.equal(opened.title, sampleAppMeta(kind).title);
    assert.equal(opened.displayMode, sampleAppMeta(kind).displayMode);
    host.closeApp(opened.appId);
  }
  assert.throws(() => host.openSampleApp('nope'), /Sample kind/);
});

test('host: openAppFromComponents renders kit apps under ui://local', () => {
  const host = new McpAppHostV13();
  const opened = host.openAppFromComponents(
    [{ type: 'metric', label: 'Score', value: 99, trend: 'up' }],
    { title: 'Kit app', displayMode: 'fullscreen' },
  );
  assert.equal(opened.serverName, 'local');
  assert.equal(opened.displayMode, 'fullscreen');
  assert.match(opened.uri, /^ui:\/\/local\//);
  assert.equal(host.registry.size, 1);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

const CTX = { workspaceDir: '/tmp/open-bot-test-ws', botId: 'bot-test' };

test('tools: 7 tools exported, names match, factory shares one host', async () => {
  assert.deepEqual([...MCP_APPS_V113_TOOL_NAMES], [
    'mcp_apps_ui_register',
    'mcp_apps_ui_list',
    'mcp_apps_ui_open',
    'mcp_apps_ui_set_display_mode',
    'mcp_apps_ui_model_context',
    'mcp_apps_components_render',
    'mcp_apps_ui_sample',
  ]);
  assert.equal(MCP_APPS_V113_TOOLS.length, 7);
  assert.deepEqual(
    MCP_APPS_V113_TOOLS.map((t) => t.definition.name),
    [...MCP_APPS_V113_TOOL_NAMES],
  );
  const host = new McpAppHostV13();
  const tools = createMcpAppsV113Tools(host);
  assert.equal(tools.length, 7);
  const register = toolByName(tools, 'mcp_apps_ui_register');
  const list = toolByName(tools, 'mcp_apps_ui_list');
  assert.equal(register.needsApproval, false);
  assert.equal(toolByName(tools, 'mcp_apps_ui_open').needsApproval, true);
  const out = JSON.parse(await register.execute({ uri: 'ui://srv/t', html: SAFE_TOOL_HTML, title: 'T' }, CTX));
  assert.equal(out.ok, true);
  assert.equal(out.version, 1);
  const listed = JSON.parse(await list.execute({}, CTX));
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].uri, 'ui://srv/t');
});

test('tools: open + set display mode + model context round-trip', async () => {
  const host = new McpAppHostV13();
  const tools = createMcpAppsV113Tools(host);
  await toolByName(tools, 'mcp_apps_ui_register').execute(
    { uri: 'ui://srv/dash', html: SAFE_TOOL_HTML, title: 'Dash', displayMode: 'inline' },
    CTX,
  );
  const opened = JSON.parse(
    await toolByName(tools, 'mcp_apps_ui_open').execute({ uri: 'ui://srv/dash', displayMode: 'pip' }, CTX),
  );
  assert.equal(opened.ok, true);
  assert.equal(opened.displayMode, 'pip');
  assert.equal(opened.sandbox, 'allow-scripts');
  const moved = JSON.parse(
    await toolByName(tools, 'mcp_apps_ui_set_display_mode').execute(
      { appId: opened.appId, mode: 'pip', x: 100, y: 100, width: 400, height: 300 },
      CTX,
    ),
  );
  assert.equal(moved.mode, 'pip');
  assert.equal(moved.pip.x, 100);
  assert.equal(moved.pip.width, 400);
  const pushed = JSON.parse(
    await toolByName(tools, 'mcp_apps_ui_model_context').execute(
      { appId: opened.appId, context: { taskStatus: 'working', progress: 10 } },
      CTX,
    ),
  );
  assert.equal(pushed.notification.method, 'ui/model-context-updated');
  await assert.rejects(
    toolByName(tools, 'mcp_apps_ui_open').execute({ uri: 'ui://srv/missing' }, CTX),
    /Không có app nào đăng ký/,
  );
});

test('tools: components_render validates + renders, sample opens all kinds', async () => {
  const host = new McpAppHostV13();
  const tools = createMcpAppsV113Tools(host);
  const rendered = JSON.parse(
    await toolByName(tools, 'mcp_apps_components_render').execute(
      {
        components: [
          { type: 'metric', label: 'Users', value: 42 },
          { type: 'list', title: 'Items', items: [{ title: 'One' }] },
        ],
        title: 'Kit',
      },
      CTX,
    ),
  );
  assert.equal(rendered.ok, true);
  assert.equal(rendered.valid, true);
  assert.ok(rendered.html.includes('42'));
  await assert.rejects(
    toolByName(tools, 'mcp_apps_components_render').execute({ components: [{ type: 'nope' }] }, CTX),
    /không rõ|không hợp lệ/,
  );
  for (const kind of ['dashboard', 'form', 'monitor', 'table']) {
    const opened = JSON.parse(
      await toolByName(tools, 'mcp_apps_ui_sample').execute({ kind }, CTX),
    );
    assert.equal(opened.ok, true);
    assert.equal(opened.title, sampleAppMeta(kind).title);
  }
  await assert.rejects(toolByName(tools, 'mcp_apps_ui_sample').execute({ kind: 'nope' }, CTX), /Sample kind/);
  assert.equal(host.manager.size, 4);
});
