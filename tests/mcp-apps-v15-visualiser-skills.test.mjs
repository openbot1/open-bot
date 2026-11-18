/**
 * Test v1.35 T3: MCP Apps auto-visualiser v15 + Agent Skills v15
 * (create / add / migrate) (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v15-visualiser-skills.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutoVisualiserV15,
  buildBarChartSpec,
  buildMapSpec,
  buildMermaidSpec,
  buildPieChartSpec,
  buildSankeySpec,
  buildTableSpec,
  detectVisualisation,
  renderVisualisationHtml,
  visualiseData,
} from '../packages/core/dist/mcp/appsVisualiserV15.js';
import {
  McpAppSkillsRegistryV15,
  UI_V15_BRIDGE_CLIENT_SNIPPET,
  addAppToSkill,
  createAppSkill,
  migrateAppToV15,
  renderAppTemplateHtml,
  scaffoldApp,
  validateAppSkill,
} from '../packages/core/dist/mcp/appsSkillsV15.js';

// ---------------------------------------------------------------------------
// Visualiser: detection
// ---------------------------------------------------------------------------

test('v15 visualiser: detect đúng loại cho từng hình dạng dữ liệu', () => {
  assert.equal(detectVisualisation([]), 'none');
  assert.equal(detectVisualisation('chuỗi'), 'none');
  assert.equal(detectVisualisation(42), 'none');
  assert.equal(
    detectVisualisation([
      { label: 'A', value: 10 },
      { label: 'B', value: 20 },
    ]),
    'pie-chart',
  );
  assert.equal(
    detectVisualisation([
      { label: '2026-01', value: 10 },
      { label: '2026-02', value: 20 },
      { label: '2026-03', value: 30 },
    ]),
    'line-chart',
  );
  assert.equal(
    detectVisualisation([
      { label: 'A', value: 10 },
      { label: 'B', value: -5 },
      { label: 'C', value: 30 },
      { label: 'D', value: 8 },
      { label: 'E', value: 12 },
      { label: 'F', value: 4 },
      { label: 'G', value: 9 },
      { label: 'H', value: 15 },
      { label: 'I', value: 7 },
    ]),
    'bar-chart',
  );
  assert.equal(
    detectVisualisation([
      { from: 'A', to: 'B', value: 10 },
      { from: 'B', to: 'C', value: 5 },
    ]),
    'sankey',
  );
  assert.equal(
    detectVisualisation([
      { id: 'start', label: 'Bắt đầu', next: ['review'] },
      { id: 'review', label: 'Review' },
    ]),
    'mermaid-flow',
  );
  assert.equal(
    detectVisualisation({ nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'a' }] }),
    'mermaid-flow',
  );
  assert.equal(
    detectVisualisation([
      { lat: 10.77, lng: 106.69, label: 'SG' },
      { lat: 21.02, lng: 105.85, label: 'HN' },
    ]),
    'map',
  );
  assert.equal(
    detectVisualisation([
      { name: 'A', status: 'open' },
      { name: 'B', status: 'done' },
    ]),
    'table',
  );
  assert.equal(detectVisualisation({ a: 10, b: 20 }), 'pie-chart');
  assert.equal(
    detectVisualisation({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }),
    'bar-chart',
  );
  // Tọa độ sai thì không phải map.
  assert.equal(detectVisualisation([{ lat: 999, lng: 0 }]), 'table');
});

test('v15 visualiser: bar/pie/sankey spec + lấy mẫu top-N', () => {
  const bar = buildBarChartSpec(
    [
      { label: 'A', value: 5 },
      { label: 'B', value: 15 },
    ],
    'Test',
  );
  assert.equal(bar.kind, 'bar-chart');
  assert.equal(bar.points.length, 2);
  assert.throws(() => buildBarChartSpec([{ label: 'A', value: 1 }], 'Test'), /ít nhất 2 điểm/);
  const pie = buildPieChartSpec(
    [
      { label: 'A', value: 30 },
      { label: 'B', value: 70 },
    ],
    'Tỉ lệ',
  );
  assert.equal(pie.kind, 'pie-chart');
  assert.throws(
    () =>
      buildPieChartSpec(
        [
          { label: 'A', value: 0 },
          { label: 'B', value: 0 },
        ],
        'Rỗng',
      ),
    /tổng giá trị > 0/,
  );
  const sankey = buildSankeySpec(
    [
      { from: 'Web', to: 'Checkout', value: 100 },
      { from: 'Checkout', to: 'Paid', value: 60 },
      { from: 'Bad', to: 'X', value: 0 },
    ],
    'Luồng',
  );
  assert.equal(sankey.edges.length, 2);
  assert.deepEqual(sankey.nodes, ['Web', 'Checkout', 'Paid']);
  // Lấy mẫu: 300 điểm → giữ 200.
  const many = Array.from({ length: 300 }, (_, i) => ({ label: `L${i}`, value: i }));
  const sampled = buildBarChartSpec(many, 'Nhiều');
  assert.equal(sampled.sampled, true);
  assert.equal(sampled.points.length, 200);
  assert.equal(sampled.totalPoints, 300);
  assert.equal(sampled.points[0]?.value, 299);
});

test('v15 visualiser: mermaid spec — steps nối chuỗi + graph nodes/edges + escape', () => {
  const flow = buildMermaidSpec(
    [
      { id: 'start', label: 'Bắt đầu', next: ['review'] },
      { id: 'review', label: 'Review "kỹ"' },
    ],
    'Quy trình',
  );
  assert.equal(flow.kind, 'mermaid-flow');
  assert.ok(flow.code.includes('flowchart TD'));
  assert.ok(flow.code.includes('start --> review'));
  assert.ok(!flow.code.includes('"kỹ"'));
  const graph = buildMermaidSpec(
    {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b', label: 'chuyển' }],
      direction: 'LR',
    },
    'Đồ thị',
  );
  assert.equal(graph.direction, 'LR');
  assert.ok(graph.code.includes('flowchart LR'));
  assert.ok(graph.code.includes('|chuyển|'));
  assert.throws(() => buildMermaidSpec([], 'Rỗng'), /ít nhất 1 node/);
});

test('v15 visualiser: map spec — bbox + điểm sai bị loại', () => {
  const map = buildMapSpec(
    [
      { lat: 10.77, lng: 106.69, label: 'SG' },
      { lat: 21.02, lng: 105.85, label: 'HN' },
      { lat: 999, lng: 0, label: 'Sai' },
    ],
    'Điểm',
  );
  assert.equal(map.points.length, 2);
  assert.equal(map.bbox.minLat, 10.77);
  assert.equal(map.bbox.maxLat, 21.02);
  assert.throws(() => buildMapSpec([{ lat: 999, lng: 0 }], 'Rỗng'), /ít nhất 1 điểm/);
  const table = buildTableSpec(
    [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ],
    'Bảng',
  );
  assert.deepEqual(table.columns, ['a', 'b']);
  assert.equal(table.totalRows, 2);
});

test('v15 visualiser: render HTML an toàn — SVG inline, không <script>, escape chuỗi', () => {
  const vis = visualiseData(
    [
      { label: '<script>alert(1)</script>', value: 10 },
      { label: 'B & C', value: 20 },
    ],
    { title: 'Chart <test>' },
  );
  assert.equal(vis.kind, 'pie-chart');
  assert.ok(vis.html.includes('<svg'));
  assert.ok(!vis.html.includes('<script>alert'));
  assert.ok(vis.html.includes('&lt;script&gt;'));
  assert.ok(vis.html.includes('B &amp; C'));
  assert.ok(vis.textFallback.includes('Chart <test>'));
  assert.ok(vis.textFallback.includes('33.3%'));
  const bar = visualiseData(
    [
      { label: 'A', value: 1 },
      { label: 'B', value: 2 },
    ],
    { title: 'Cột', forceKind: 'bar-chart' },
  );
  assert.ok(bar.html.includes('<rect'));
  const line = visualiseData(
    [
      { label: 'T1', value: 1 },
      { label: 'T2', value: 2 },
      { label: 'T3', value: 3 },
    ],
    { title: 'Đường', forceKind: 'line-chart' },
  );
  assert.ok(line.html.includes('<path'));
  const mermaid = visualiseData(
    [
      { id: 'a', label: 'A', next: ['b'] },
      { id: 'b', label: 'B' },
    ],
    { title: 'Flow', forceKind: 'mermaid-flow' },
  );
  assert.ok(mermaid.html.includes('language-mermaid'));
  assert.ok(mermaid.textFallback.includes('flowchart TD'));
  const map = visualiseData([{ lat: 10.77, lng: 106.69, label: 'SG' }], { title: 'Map' });
  assert.ok(map.html.includes('openstreetmap.org'));
});

test('v15 visualiser: dữ liệu không vẽ được → kind none + JSON fallback, không ném', () => {
  const vis = visualiseData('chỉ là chuỗi', { title: 'Chuỗi' });
  assert.equal(vis.kind, 'none');
  assert.ok(vis.textFallback.includes('chỉ là chuỗi'));
  assert.ok(vis.html.includes('<pre>'));
  const forced = visualiseData([{ label: 'A', value: 0 }], { title: 'Pie rỗng', forceKind: 'pie-chart' });
  // Pie tổng 0 → rơi về table/none, không crash.
  assert.ok(['table', 'none'].includes(forced.kind));
  assert.ok(forced.warnings.length >= 1);
  const viz = new AutoVisualiserV15();
  viz.visualise([{ label: 'A', value: 1 }, { label: 'B', value: 2 }]);
  viz.visualise([{ lat: 1, lng: 2 }]);
  assert.equal(viz.stats().total, 2);
  assert.equal(viz.stats().byKind['pie-chart'], 1);
  assert.equal(viz.stats().byKind['map'], 1);
  assert.equal(renderVisualisationHtml({ kind: 'none', title: 'X' }).includes('không vẽ được'), true);
});

// ---------------------------------------------------------------------------
// Skills: scaffold / create / add / migrate
// ---------------------------------------------------------------------------

test('v15 skills: scaffold đủ 5 template — HTML document + manifest khớp', () => {
  for (const template of ['dashboard', 'form', 'chart', 'wizard', 'blank']) {
    const app = scaffoldApp({ appName: `my-${template}`, serverName: 'local-apps', template });
    assert.equal(app.template, template);
    assert.equal(app.resourceUri, `ui://local-apps/my-${template}`);
    assert.equal(app.mimeType, 'text/html;profile=mcp-app');
    assert.ok(app.html.startsWith('<!doctype html>'));
    assert.ok(app.html.includes('McpAppBridge'));
    assert.equal(app.manifest.name, `my-${template}`);
    assert.equal(app.files.length, 2);
    assert.ok(app.files.some((f) => f.path.endsWith('manifest.json')));
    if (template === 'form' || template === 'wizard') {
      assert.ok(app.manifest.capabilities.includes('tools-call'));
      assert.equal(app.manifest.sandboxProfile, 'interactive');
    }
  }
  assert.throws(() => scaffoldApp({ appName: 'Bad Name', serverName: 's' }), /kebab-case/);
  assert.throws(() => scaffoldApp({ appName: 'ok', serverName: '' }), /serverName rỗng/);
  assert.throws(
    () => scaffoldApp({ appName: 'ok', serverName: 's', template: 'nope' }),
    /Template không rõ/,
  );
});

test('v15 skills: render template HTML theo template — form có submit, wizard có bước', () => {
  const form = renderAppTemplateHtml('form', 'my-form');
  assert.ok(form.includes('id="app-form"'));
  assert.ok(form.includes('submit-form'));
  const wizard = renderAppTemplateHtml('wizard', 'my-wizard');
  assert.ok(wizard.includes('Bước 1'));
  assert.ok(wizard.includes('wizard-complete'));
  const dash = renderAppTemplateHtml('dashboard', 'my-dash');
  assert.ok(dash.includes('Dashboard'));
  assert.ok(UI_V15_BRIDGE_CLIENT_SNIPPET.includes('ui/initialize'));
  assert.ok(UI_V15_BRIDGE_CLIENT_SNIPPET.includes('postMessage'));
  assert.ok(!UI_V15_BRIDGE_CLIENT_SNIPPET.includes('eval('));
});

test('v15 skills: create skill — SKILL.md + manifest + app mẫu, validate đạt', () => {
  const skill = createAppSkill({
    name: 'sales-apps',
    description: 'Skill tạo app dashboard bán hàng cho đội kinh doanh theo dõi doanh số mỗi ngày.',
    defaultTemplate: 'dashboard',
    defaultServer: 'local-apps',
    author: 'Huy',
  });
  assert.equal(skill.manifest.name, 'sales-apps');
  assert.deepEqual(skill.manifest.apps, ['sales-apps']);
  assert.ok(skill.skillMd.includes('sales-apps'));
  assert.ok(skill.skillMd.includes('consent'));
  assert.ok(skill.skillMd.length >= 200);
  assert.ok(skill.files.some((f) => f.path === 'SKILL.md'));
  assert.ok(skill.files.some((f) => f.path === 'skill.json'));
  assert.ok(skill.files.some((f) => f.path === 'apps/sales-apps/app.html'));
  const check = validateAppSkill(skill);
  assert.equal(check.ok, true);
  assert.deepEqual(check.errors, []);
  assert.throws(
    () => createAppSkill({ name: 'x', description: 'ngắn' }),
    /tối thiểu 20 ký tự/,
  );
  assert.throws(() => createAppSkill({ name: 'Bad Name', description: 'Mô tả đủ dài cho skill này nhé.' }), /kebab-case/);
});

test('v15 skills: add app vào skill — trùng tên lỗi, đủ app thì đầy', () => {
  const skill = createAppSkill({
    name: 'team-apps',
    description: 'Skill tạo app nội bộ cho đội làm việc chung mỗi ngày.',
  });
  const { skill: updated, app } = addAppToSkill(skill, {
    appName: 'team-form',
    serverName: 'local-apps',
    template: 'form',
  });
  assert.deepEqual(updated.manifest.apps, ['team-apps', 'team-form']);
  assert.equal(app.resourceUri, 'ui://local-apps/team-form');
  assert.ok(updated.skillMd.includes('team-form'));
  assert.throws(
    () => addAppToSkill(updated, { appName: 'team-form', serverName: 'local-apps' }),
    /đã có app/,
  );
  const check = validateAppSkill(updated);
  assert.equal(check.ok, true);
});

test('v15 skills: registry — register validate, scaffold bằng skill, lỗi khi chưa đăng ký', () => {
  const registry = new McpAppSkillsRegistryV15();
  const skill = createAppSkill({
    name: 'ops-apps',
    description: 'Skill tạo app vận hành hệ thống cho đội ops theo dõi mỗi ngày.',
  });
  registry.register(skill);
  assert.equal(registry.size, 1);
  assert.equal(registry.has('ops-apps'), true);
  const app = registry.scaffoldWithSkill('ops-apps', { appName: 'ops-chart', serverName: 'local-apps' });
  assert.equal(app.template, 'dashboard');
  assert.throws(
    () => registry.scaffoldWithSkill('missing-skill', { appName: 'x', serverName: 's' }),
    /chưa đăng ký/,
  );
  assert.throws(() => registry.register({ manifest: { name: 'bad' } }), /không đạt validate/);
  assert.equal(registry.unregister('ops-apps'), true);
  assert.equal(registry.size, 0);
});

test('v15 skills: migrate v14 → v15 — thêm bridge snippet, sinh manifest, liệt kê change', () => {
  const oldHtml =
    '<!doctype html><html><head><title>Old</title></head><body><h1>App cũ</h1><p>Không có bridge.</p></body></html>';
  const migrated = migrateAppToV15({
    html: oldHtml,
    resourceUri: 'ui://my-server/old-app',
    serverName: 'my-server',
    fromVersion: '14',
    toolName: 'show-old',
  });
  assert.ok(migrated.html.includes('McpAppBridge'));
  assert.equal(migrated.manifest.name, 'old-app');
  assert.equal(migrated.manifest.version, '1.0.0');
  assert.equal(migrated.manifest.server, 'my-server');
  assert.ok(migrated.changes.some((c) => /bridge client v15/.test(c)));
  assert.ok(migrated.changes.some((c) => /manifest v15/.test(c)));
  assert.equal(migrated.files.length, 2);
  // App đã có bridge → giữ nguyên, không thêm lại.
  const already = migrateAppToV15({
    html: migrated.html,
    resourceUri: 'ui://my-server/old-app',
    serverName: 'my-server',
    fromVersion: '14',
  });
  assert.ok(already.changes.some((c) => /giữ nguyên/.test(c)));
  assert.ok(already.warnings.length >= 1);
  // App có tools/call → suy ra capability + cảnh báo consent.
  const withTool = migrateAppToV15({
    html: '<!doctype html><html><body><script>fetch("/x"); McpAppBridge.callTool("create-task", {});</script></body></html>',
    resourceUri: 'ui://my-server/tool-app',
    serverName: 'my-server',
    fromVersion: '13',
  });
  assert.ok(withTool.manifest.capabilities.includes('tools-call'));
  assert.ok(withTool.warnings.some((w) => /consent/.test(w)));
  // HTML xấu → từ chối migrate.
  assert.throws(
    () =>
      migrateAppToV15({
        html: '<p>đoạn lẻ</p>',
        resourceUri: 'ui://my-server/bad',
        serverName: 'my-server',
      }),
    /HTML document đầy đủ/,
  );
  assert.throws(
    () =>
      migrateAppToV15({
        html: oldHtml,
        resourceUri: 'https://example.com/app',
        serverName: 'my-server',
      }),
    /bắt đầu bằng "ui:\/\/"/,
  );
});

test('v15 skills: validate skill lỗi — thiếu manifest / SKILL.md ngắn / không có app html', () => {
  assert.equal(validateAppSkill({}).ok, false);
  assert.equal(validateAppSkill({ manifest: {} }).ok, false);
  const skill = createAppSkill({
    name: 'warn-apps',
    description: 'Skill tạo app demo cho đội kiểm tra tính năng mới mỗi ngày.',
  });
  const noConsent = { ...skill, skillMd: '# warn-apps\n\nMô tả ngắn gọn thôi.\n'.repeat(10) };
  const check = validateAppSkill(noConsent);
  assert.ok(check.warnings.some((w) => /consent/.test(w)));
});
